// REWARDS-EXEC-01D — integration of the existing pieces into the five-minute cycle. WORKER-ONLY.
// Every function takes injected I/O (rpc, db) so it can be tested with real finalized fixtures and a throwaway DB.
//   D02 sealedFromFrozen : entitlements from the exact frozen snapshot of the window (never current balances)
//   D03 vaultLamports    : verified creator-fee vault state (curve SOL vault + PumpSwap WSOL vault)
//       ingestFees       : finalized collect events → 30/30/40 receipts (existing ledger), provenance-checked
//   D04 settlementChain  : finalized getTransaction → verifySettlement against the PERSISTED plan (0020)
//       captureFills     : LANDED buyback → verifyFill → append-only mcpx_rw_buyback_fills (idempotent)
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";
import { verifySettlement, verifyFill, type FinalTx } from "./settlement";
import type { Chain } from "./executor";
import { scanRecipient, type Rpc as ScanRpc } from "../../../src/lib/rewards/scanner";
import { ingestCreatorFee, type Provenance } from "../../../src/lib/rewards/native-single";
import { holderSplit, type Store } from "../../../src/lib/rewards/processor";
import { PUMP_PROGRAM, PUMP_AMM_PROGRAM, WSOL_MINT } from "../../../src/lib/rewards/pump-events";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const BURN_ADDRESSES = ["1nc1nerator11111111111111111111111111111111"];
const enc = getAddressEncoder();

// ---------------- D02: frozen snapshot → entitlements ----------------
export type Frozen = { completeness: string; cutoffSlot: number; digest: string; owners: { owner: string; amount: bigint; class: string; reason: string | null }[] };

/** Entitlements for one window from ITS frozen snapshot only. Any AMBIGUOUS owner, incomplete snapshot, or an
 *  "eligible" owner that is a known excluded address (deployer/burn/vault) blocks the window — never paid around. */
export function sealedFromFrozen(f: Frozen | null, x: { deployer: string; excluded: readonly string[]; solTotal: bigint; minPayable: bigint }) {
  if (!f) return null;
  const known = new Set([x.deployer, ...BURN_ADDRESSES, ...x.excluded]);
  const eligible = f.owners.filter((o) => o.class === "ELIGIBLE" && o.amount > 0n);
  const complete = f.completeness === "COMPLETE" && !f.owners.some((o) => o.class === "AMBIGUOUS") && !eligible.some((o) => known.has(o.owner));
  const holders = eligible.map((o) => ({ owner: o.owner, amount: o.amount }));
  const split = (total: bigint) => holderSplit(total, holders, new Map(), x.minPayable).paid.map((p) => ({ owner: p.owner, amount: p.lamports }));
  return { snapshotComplete: complete && holders.length > 0, solRows: complete ? split(x.solTotal) : [], tokenRowsFor: (inv: bigint) => (complete && inv > 0n ? split(inv) : []),
    cutoffSlot: f.cutoffSlot, digest: f.digest };
}

// ---------------- D03: creator-fee vaults ----------------
export async function creatorVaults(deployer: string) {
  const [curveVault] = await getProgramDerivedAddress({ programAddress: address(PUMP_PROGRAM), seeds: ["creator-vault", enc.encode(address(deployer))] });
  const [ammAuth] = await getProgramDerivedAddress({ programAddress: address(PUMP_AMM_PROGRAM), seeds: ["creator_vault", enc.encode(address(deployer))] });
  const [ammVault] = await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [enc.encode(ammAuth), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(WSOL_MINT))] });
  return { curveVault: String(curveVault), ammAuthority: String(ammAuth), ammWsolVault: String(ammVault) };
}

/** Collectable creator fees at finalized commitment: curve vault lamports above rent + PumpSwap WSOL vault amount.
 *  null = unknown (RPC failure) — never zero. Balance is only a trigger to collect; income = finalized collect events. */
export async function vaultLamports(rpc: RpcCall, deployer: string): Promise<{ curve: bigint; amm: bigint; total: bigint } | null> {
  try {
    const v = await creatorVaults(deployer);
    const info = (await rpc("getAccountInfo", [v.curveVault, { commitment: "finalized", encoding: "base64" }])) as { value: { lamports: number; data: [string, string] } | null };
    let curve = 0n;
    if (info.value) {
      const len = Buffer.from(info.value.data[0], "base64").length;
      const rent = BigInt(Number(await rpc("getMinimumBalanceForRentExemption", [len, { commitment: "finalized" }])));
      curve = BigInt(info.value.lamports) > rent ? BigInt(info.value.lamports) - rent : 0n;
    }
    let amm = 0n;
    try {
      const b = (await rpc("getTokenAccountBalance", [v.ammWsolVault, { commitment: "finalized" }])) as { value: { amount: string } };
      amm = BigInt(b.value.amount);
    } catch (e) { if (!/could not find account|Invalid param/i.test(String((e as Error).message))) throw e; }
    return { curve, amm, total: curve + amm };
  } catch { return null; }
}

/** Provenance for creator-fee attribution: every mint the deployer ever initialised (bounded scan of its full
 *  finalized history, jsonParsed). Pump vaults pool fees across a creator's coins, so anything but exactly [$MCP]
 *  blocks attribution. History beyond the bound → null (UNKNOWN), never assumed clean. */
export async function deployerProvenance(rpc: RpcCall, deployer: string, maxSignatures = 2000): Promise<Provenance> {
  try {
    const sigs: { signature: string; err: unknown }[] = []; let before: string | undefined;
    for (;;) {
      const page = (await rpc("getSignaturesForAddress", [deployer, { commitment: "finalized", limit: 1000, ...(before ? { before } : {}) }])) as { signature: string; err: unknown }[];
      sigs.push(...page);
      if (sigs.length > maxSignatures) return { createdMints: null };
      if (page.length < 1000) break;
      before = page[page.length - 1]!.signature;
    }
    const minted = new Set<string>();
    for (const s of sigs) {
      if (s.err) continue;
      const t = (await rpc("getTransaction", [s.signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])) as
        { transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: P[] } }; meta: { innerInstructions?: { instructions: P[] }[] } | null } | null;
      if (!t) return { createdMints: null };
      if (!t.transaction.message.accountKeys.some((k) => k.pubkey === deployer && k.signer)) continue;
      const all = [...t.transaction.message.instructions, ...(t.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
      for (const ix of all) if (ix.parsed && /^initializeMint2?$/.test(ix.parsed.type) && ix.parsed.info?.mint) minted.add(ix.parsed.info.mint);
    }
    return { createdMints: [...minted].sort() };
  } catch { return { createdMints: null }; }
}
type P = { parsed?: { type: string; info?: { mint?: string } } };

/** Scan finalized deployer history for collect events and ingest them through the existing keyed 30/30/40 ledger.
 *  Cursor advances only after every event in range was ingested or explicitly rejected. */
export async function ingestFees(db: Q, store: Store, scan: ScanRpc, x: { mint: string; deployer: string; provenance: Provenance; wsolOwner?: (ata: string) => Promise<{ owner: string; mint: string } | null> }) {
  const src = `fees:${x.deployer}`;
  const cur = (await db.query("select last_signature from public.mcpx_rw_cursors where source=$1", [src])).rows[0]?.["last_signature"] as string | undefined;
  const s = await scanRecipient(scan, x.deployer, cur ?? null);
  if (s.kind === "UNKNOWN") return { kind: "UNKNOWN" as const, reason: s.reason };
  const out: { key: string; result: string }[] = [];
  for (const ev of s.events) {
    if (ev.source === "PUMP_AMM_COLLECT_COIN_CREATOR" && ev.extra["destinationTokenAccount"] && x.wsolOwner) {
      const o = await x.wsolOwner(ev.extra["destinationTokenAccount"]!);
      if (o) { ev.extra["verifiedDestinationOwner"] = o.owner; ev.extra["verifiedDestinationMint"] = o.mint; }
    }
    const r = await ingestCreatorFee(store, { mint: x.mint, deployerWallet: x.deployer, childFeeWallets: [] }, ev, true, x.provenance);
    out.push({ key: `${ev.signature}:${ev.ixIndex}:${ev.eventIndex}`, result: r.kind === "REJECTED" ? `REJECTED:${r.reason}` : r.kind });
  }
  // A provenance block is not "processed" — leave the cursor so those events are ingested once provenance is proven.
  if (out.some((o) => o.result === "REJECTED:PROVENANCE_UNKNOWN" || o.result === "REJECTED:DEPLOYER_CREATED_OTHER_COINS"))
    return { kind: "HELD" as const, reason: "FEE_PROVENANCE_NOT_PROVEN", events: out };
  if (s.newCursor && s.newCursor !== cur)
    await db.query(`insert into public.mcpx_rw_cursors (source, last_signature) values ($1,$2)
      on conflict (source) do update set last_signature=excluded.last_signature, updated_at=now()`, [src, s.newCursor]);
  return { kind: "OK" as const, events: out, complete: s.complete };
}

// ---------------- D04: settlement + fills ----------------
const getTx = async (rpc: RpcCall, sig: string) =>
  (await rpc("getTransaction", [sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }])) as FinalTx;

/** Persisted plan for settlement (0020 columns). Missing plan → null → never LANDED. */
export async function persistedPlan(db: Q, key: string) {
  const r = (await db.query(`select kind, message_sha256, message_base64, plan_rows, plan_mint, plan_token_program, signature
    from public.mcpx_rw_intents where idempotency_key=$1`, [key])).rows[0];
  if (!r || !Array.isArray(r["plan_rows"]) || !r["message_base64"]) return null;
  return { kind: String(r["kind"]), messageSha256: String(r["message_sha256"]), messageBase64: String(r["message_base64"]),
    rows: (r["plan_rows"] as { owner: string; amount: string }[]).map((x) => ({ owner: x.owner, amount: BigInt(x.amount) })),
    mint: (r["plan_mint"] as string | null) ?? undefined, tokenProgram: (r["plan_token_program"] as string | null) ?? undefined };
}

/** Read-only Chain for reconcileOpen. settlement() proves exact deltas against the persisted plan; anything short
 *  of PROVEN returns null (HELD_NO_PROOF) — a signature status alone never marks an intent paid. */
export function settlementChain(rpc: RpcCall, db: Q, deployer: string): Chain {
  return {
    async signatureStatus(sig) {
      try {
        const v = ((await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }])) as { value: ({ slot: number; err: unknown; confirmationStatus: string } | null)[] }).value[0];
        if (!v) return { status: "NOT_FOUND", slot: null };
        if (v.confirmationStatus !== "finalized") return { status: "UNKNOWN", slot: null };
        return { status: v.err ? "FINALIZED_ERR" : "FINALIZED_OK", slot: v.slot };
      } catch { return { status: "UNKNOWN", slot: null }; }
    },
    async finalizedBlockHeight() { try { return Number(await rpc("getBlockHeight", [{ commitment: "finalized" }])); } catch { return null; } },
    async settlement(sig, i) {
      try {
        const key = i.idempotencyKey; if (!key) return null;
        if (i.kind === "BUYBACK") { // landed swap; tokens are proven separately by captureFills before any token payout
          const t = await getTx(rpc, sig); if (!t?.meta || t.meta.err !== null || t.transaction.signatures[0] !== sig) return null;
          return { kind: "SWAP_FINALIZED", slot: t.slot };
        }
        if (i.kind !== "SOL_PAYOUT" && i.kind !== "TOKEN_PAYOUT") return null;
        const p = await persistedPlan(db, key); if (!p) return null;
        const proof = verifySettlement(await getTx(rpc, sig), { kind: i.kind, signature: sig, deployer, messageSha256: p.messageSha256, messageBase64: p.messageBase64, rows: p.rows, ...(p.mint ? { mint: p.mint } : {}), ...(p.tokenProgram ? { tokenProgram: p.tokenProgram } : {}) });
        return proof.kind === "PROVEN" ? proof : null;
      } catch { return null; }
    },
  };
}

export async function pendingFills(db: Q, epoch: number) {
  const r = await db.query(`select count(*)::int n from public.mcpx_rw_intents i where i.kind='BUYBACK' and i.state='LANDED' and i.epoch_start=to_timestamp($1)
    and not exists (select 1 from public.mcpx_rw_buyback_fills f where f.intent_key=i.idempotency_key)`, [epoch]);
  return Number(r.rows[0]?.["n"] ?? 0);
}

/** LANDED buybacks without a fill → verify actual tokens received from finalized balances → append fill (idempotent
 *  by signature PK + DB guard requiring a LANDED BUYBACK intent with the same signature and epoch). */
export async function captureFills(db: Q, rpc: RpcCall, x: { deployer: string; mint: string; decimals: number }) {
  const open = (await db.query(`select i.idempotency_key k, i.signature s, i.lamports::text l, extract(epoch from i.epoch_start)::bigint::text e
    from public.mcpx_rw_intents i where i.kind='BUYBACK' and i.state='LANDED'
    and not exists (select 1 from public.mcpx_rw_buyback_fills f where f.intent_key=i.idempotency_key) order by i.created_at`)).rows;
  const out: { key: string; result: string }[] = [];
  for (const o of open) {
    const sig = String(o["s"]);
    let t: FinalTx; try { t = await getTx(rpc, sig); } catch { out.push({ key: String(o["k"]), result: "UNKNOWN:RPC" }); continue; }
    const programs = t ? [...t.transaction.message.accountKeys ?? t.transaction.message.staticAccountKeys ?? []] : [];
    const f = verifyFill(t, { signature: sig, deployer: x.deployer, mint: x.mint, maxSolLamports: BigInt(String(o["l"])), minOutTokens: 1n, venues: [PUMP_PROGRAM, PUMP_AMM_PROGRAM] }, programs);
    if (f.kind !== "FILL") { out.push({ key: String(o["k"]), result: `${f.kind}:${f.reason}` }); continue; }
    await db.query(`insert into public.mcpx_rw_buyback_fills (signature, intent_key, epoch_start, mint, decimals, token_amount, sol_spent, finalized_slot, evidence)
      values ($1,$2,to_timestamp($3),$4,$5,$6::numeric,$7::numeric,$8,$9::jsonb) on conflict (signature) do nothing`,
      [sig, String(o["k"]), Number(o["e"]), x.mint, x.decimals, f.tokensReceived, f.solSpent, f.slot, JSON.stringify(f)]);
    out.push({ key: String(o["k"]), result: "FILL_RECORDED" });
  }
  return out;
}
