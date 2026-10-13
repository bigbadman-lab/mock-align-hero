// Phase 05-H — Helius (Developer plan) finalized history source for the holder index. READ-ONLY.
// Completeness argument (per mint, up to a fixed finalized slot C):
//  1. Every token account of a mint is created by an instruction that references the mint (InitializeAccount*/ATA create),
//     so getTransactionsForAddress(mint) discovers every account that ever existed, including ones later closed.
//  2. Every later change to a token account (Transfer without mint, CloseAccount, SetAuthority/owner change, burn)
//     references that token account, so per-account history covers every transition.
//  3. Replay of the union in (slot, transactionIndex) order must hit zero pre-balance mismatches and end equal to
//     getProgramAccounts + getTokenSupply read at the same finalized context slot C. Anything else = BLOCKED.
import type { IndexedTx, TokenBal } from "../../../src/lib/rewards/holder-index";

export type Meter = Record<string, { calls: number; items: number }>;
export type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function heliusRpc(url: string, meter: Meter): Rpc {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      if (r.status === 429 && attempt < 6) { await new Promise((s) => setTimeout(s, 500 * 2 ** attempt)); continue; }
      const j = (await r.json()) as { result?: any; error?: { message: string } };
      (meter[method] ??= { calls: 0, items: 0 }).calls++;
      if (j.error) throw new Error(`${method}:${j.error.message}`);
      return j.result;
    }
  };
}

/** Credits per Helius billing docs (05-H). gTFA full = 10 per 100 returned; signatures = 10 flat; gPA = 10. */
export function credits(m: Meter, archivalCost = 10) {
  const g = (k: string) => m[k] ?? { calls: 0, items: 0 };
  return g("gTFA:full").items / 100 * 10 + g("gTFA:full").calls * 0 + g("gTFA:sigs").calls * 10
    + g("getTransaction").calls * archivalCost + g("getProgramAccounts").calls * 10 + g("getTokenSupply").calls * 1 + g("getSlot").calls;
}

type FullTx = { slot: number; transactionIndex: number; blockTime: number | null; transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: { err: unknown; preTokenBalances?: any[]; postTokenBalances?: any[]; loadedAddresses?: { writable: string[]; readonly: string[] } } };

export function toIndexed(t: FullTx, mint: string): IndexedTx & { txIndex: number } {
  const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  const conv = (bs: any[] | undefined): TokenBal[] => (bs ?? []).filter((b) => b.mint === mint)
    .map((b) => ({ account: keys[b.accountIndex]!, owner: b.owner ?? null, mint, amount: BigInt(b.uiTokenAmount.amount) }));
  return { signature: t.transaction.signatures[0]!, slot: t.slot, txIndex: t.transactionIndex, blockTime: t.blockTime, finalized: true,
    failed: t.meta.err !== null, pre: conv(t.meta.preTokenBalances), post: conv(t.meta.postTokenBalances) };
}

const OPTS = { sortOrder: "asc", commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 1 } as const;

export async function fullHistory(rpc: Rpc, meter: Meter, address: string, mint: string, lteSlot: number) {
  const out: (IndexedTx & { txIndex: number })[] = []; let token: string | undefined;
  do {
    const r = await rpc("getTransactionsForAddress", [address, { ...OPTS, transactionDetails: "full", limit: 100, filters: { slot: { lte: lteSlot } }, ...(token ? { paginationToken: token } : {}) }]);
    (meter["gTFA:full"] ??= { calls: 0, items: 0 }).calls++; meter["gTFA:full"]!.items += r.data.length;
    for (const t of r.data) out.push(toIndexed(t, mint));
    token = r.data.length ? r.paginationToken ?? undefined : undefined;
  } while (token);
  return out;
}

export async function signatures(rpc: Rpc, meter: Meter, address: string, lteSlot: number) {
  const out: { signature: string; slot: number; txIndex: number }[] = []; let token: string | undefined;
  do {
    const r = await rpc("getTransactionsForAddress", [address, { ...OPTS, transactionDetails: "signatures", limit: 1000, filters: { slot: { lte: lteSlot } }, ...(token ? { paginationToken: token } : {}) }]);
    (meter["gTFA:sigs"] ??= { calls: 0, items: 0 }).calls++; meter["gTFA:sigs"]!.items += r.data.length;
    for (const s of r.data) out.push({ signature: s.signature, slot: s.slot, txIndex: s.transactionIndex });
    token = r.data.length ? r.paginationToken ?? undefined : undefined;
  } while (token);
  return out;
}

/** Current state at one finalized context slot: all token accounts of the mint + supply, both at the same slot. */
export async function stateAtSameSlot(rpc: Rpc, mint: string, tokenProgram: string, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const [gpa, sup] = await Promise.all([
      rpc("getProgramAccounts", [tokenProgram, { commitment: "finalized", encoding: "jsonParsed", withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint } }] }]),
      rpc("getTokenSupply", [mint, { commitment: "finalized" }]),
    ]);
    if (gpa.context.slot !== sup.context.slot) continue;
    const accounts = new Map<string, { owner: string; amount: bigint }>();
    for (const a of gpa.value) { const info = a.account.data.parsed.info; accounts.set(a.pubkey, { owner: info.owner, amount: BigInt(info.tokenAmount.amount) }); }
    return { slot: gpa.context.slot as number, supply: BigInt(sup.value.amount), accounts };
  }
  return null; // could not read both at one consistent finalized position
}

/**
 * Cheap per-window completeness check: read every known open token account at one finalized context slot with
 * getMultipleAccounts (1 credit / 100 accounts) and compare amount+owner with the replayed index at that slot.
 * Any transition missed by the mint-referenced feed (plain Transfer, SetAuthority, Close) changes a known account
 * and shows up here; only those accounts then need a per-account history fetch.
 */
export async function verifyKnownAccounts(rpc: Rpc, accounts: string[]) {
  const out = new Map<string, { owner: string; amount: bigint } | null>(); let slot: number | null = null;
  for (let i = 0; i < accounts.length; i += 100) {
    const part = accounts.slice(i, i + 100);
    const r = await rpc("getMultipleAccounts", [part, { commitment: "finalized", encoding: "jsonParsed", ...(slot ? { minContextSlot: slot } : {}) }]);
    if (slot === null) slot = r.context.slot; else if (r.context.slot !== slot) return null; // inconsistent position → retry caller
    r.value.forEach((v: any, k: number) => out.set(part[k]!, v ? { owner: v.data.parsed.info.owner, amount: BigInt(v.data.parsed.info.tokenAmount.amount) } : null));
  }
  return { slot: slot!, accounts: out };
}
