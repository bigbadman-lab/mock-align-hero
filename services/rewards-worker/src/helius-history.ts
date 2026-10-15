import { freshFetch } from "./fresh-fetch";
// Phase 05-H — Helius (Developer plan) finalized history source for the holder index. READ-ONLY.
// Completeness argument (per mint, up to a fixed finalized slot C):
//  1. Every token account of a mint is created by an instruction that references the mint (InitializeAccount*/ATA create),
//     so getTransactionsForAddress(mint) discovers every account that ever existed, including ones later closed.
//  2. Every later change to a token account (Transfer without mint, CloseAccount, SetAuthority/owner change, burn)
//     references that token account, so per-account history covers every transition.
//  3. Replay of the union in (slot, transactionIndex) order must hit zero pre-balance mismatches and end equal to
//     getProgramAccounts + getTokenSupply read at the same finalized context slot C. Anything else = BLOCKED.
import type { IndexedTx, TokenBal } from "../../../src/lib/rewards/holder-index";
import { supplyDelta, type RawTx } from "../../../src/lib/rewards/supply-proof";
import type { CutoffDeps } from "../../../src/lib/rewards/cutoff";

export type Meter = Record<string, { calls: number; items: number }>;
export type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function heliusRpc(url: string, meter: Meter): Rpc {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const r = await freshFetch(url, { method: "POST", headers: { "content-type": "application/json" },
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
    + g("getTransaction").calls * archivalCost + g("getProgramAccounts").calls * 10
    // every other standard RPC method (getSlot, getBlocks, getBlockTime, getMultipleAccounts, getTokenSupply…) = 1 credit/call
    + Object.entries(m).filter(([k]) => !["gTFA:full", "gTFA:sigs", "getTransactionsForAddress", "getTransaction", "getProgramAccounts"].includes(k)).reduce((x, [, v]) => x + v.calls, 0);
}

type FullTx = { slot: number; transactionIndex: number; blockTime: number | null; transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: { err: unknown; preTokenBalances?: any[]; postTokenBalances?: any[]; loadedAddresses?: { writable: string[]; readonly: string[] } } };

export function toIndexed(t: FullTx, mint: string): IndexedTx & { txIndex: number; supplyDelta: bigint | { unknown: string } } {
  const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  const conv = (bs: any[] | undefined): TokenBal[] => (bs ?? []).filter((b) => b.mint === mint)
    .map((b) => ({ account: keys[b.accountIndex]!, owner: b.owner ?? null, mint, amount: BigInt(b.uiTokenAmount.amount) }));
  return { signature: t.transaction.signatures[0]!, slot: t.slot, txIndex: t.transactionIndex, blockTime: t.blockTime, finalized: true,
    failed: t.meta.err !== null, pre: conv(t.meta.preTokenBalances), post: conv(t.meta.postTokenBalances),
    supplyDelta: (t.transaction.message as any).instructions ? supplyDelta(t as unknown as RawTx, mint) : { unknown: "no_instructions" } };
}

const OPTS = { sortOrder: "asc", commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 } as const;

export async function fullHistory(rpc: Rpc, meter: Meter, address: string, mint: string, lteSlot: number, gtSlot?: number) {
  const out: ReturnType<typeof toIndexed>[] = []; let token: string | undefined;
  do {
    const r = await rpc("getTransactionsForAddress", [address, { ...OPTS, transactionDetails: "full", limit: 100, filters: { slot: { lte: lteSlot, ...(gtSlot !== undefined ? { gt: gtSlot } : {}) } }, ...(token ? { paginationToken: token } : {}) }]);
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
  const out = new Map<string, { owner: string; amount: bigint } | null>();
  const parts: string[][] = []; for (let i = 0; i < accounts.length; i += 100) parts.push(accounts.slice(i, i + 100));
  for (let attempt = 0; attempt < 8; attempt++) {
    // parallel reads usually land on one finalized slot; any disagreement → retry, never mix positions
    const rs = await Promise.all(parts.map((p) => rpc("getMultipleAccounts", [p, { commitment: "finalized", encoding: "jsonParsed" }])));
    const slot = rs[0].context.slot as number;
    if (!rs.every((r: any) => r.context.slot === slot)) continue;
    rs.forEach((r: any, i: number) => r.value.forEach((v: any, k: number) => out.set(parts[i]![k]!, !v ? null
      : v.data?.parsed?.type === "mint" ? { owner: "__MINT_SUPPLY__", amount: BigInt(v.data.parsed.info.supply) } // 05-I: supply at the same slot
      : { owner: v.data.parsed.info.owner, amount: BigInt(v.data.parsed.info.tokenAmount.amount) })));
    return { slot, accounts: out };
  }
  return null;
}

/** 05-I: finalized-only cutoff RPC adapter. undefined = RPC failure (→ HOLD), null = genuinely absent block time. */
export function cutoffDeps(rpc: Rpc): CutoffDeps {
  return {
    finalizedHead: async () => { try { return (await rpc("getSlot", [{ commitment: "finalized" }])) as number; } catch { return null; } },
    produced: async (from, to) => { try { return (await rpc("getBlocks", [from, to, { commitment: "finalized" }])) as number[]; } catch { return null; } },
    blockTime: async (slot) => { try { return (await rpc("getBlockTime", [slot])) as number | null; } catch (e) { return /not available|skipped|-32009|-32004/i.test(String(e)) ? null : undefined; } },
  };
}
