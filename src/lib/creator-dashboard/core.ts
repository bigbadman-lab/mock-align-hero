// Creator dashboard projection: pure rules, no I/O. Server route composes these from existing
// authoritative records only (mcp_creations, mcpx_cf_children/intents, Treasury payout projection).
// Absent or failed data is an explicit state — never a zero.
import type { DistributionRow } from "@/lib/treasury/core";

export const CREATOR_SHARE_BPS = 6000n; // on-chain locked share, re-checked by the keeper before every distribute

export type SectionState<T> =
  | { state: "ok"; data: T }
  | { state: "not_launched" }       // $MCP or the product's token is not live yet
  | { state: "no_activity" }        // tracked, but genuinely no records
  | { state: "not_tracked"; reason: string } // backend for this does not exist yet
  | { state: "unavailable" };       // read failed — show error, never 0

export interface OwnedProduct { creationId: string; slug: string; name: string; childMint: string; verifiedAt: string }

export interface ChildRow { mint: string; quote_mint: string; creator_wallet: string }
export interface CfIntentRow { idempotency_key: string; mint: string; status: string; action: string; signature: string | null; finalized_slot: number | null; distributed_amount: string | null; updated_at: string }

export interface EarningRow {
  id: string; creationId: string; productName: string; quoteMint: string;
  distributedRaw: string; creatorShareRaw: string; signature: string; finalizedSlot: number; at: string;
}
export interface EarningsData { rows: EarningRow[]; totals: { quoteMint: string; creatorShareRaw: string; distributions: number }[]; pendingIntents: number }

/**
 * Settled creator fees = finalized Pump distributions for the creator's own child mints, where the
 * on-chain sharing config was verified to pay the session wallet 60%. Pump pays shareholders directly
 * (no MCPX custody), so there is no "claimable" balance. Totals are grouped per quote mint, never mixed.
 */
export function buildEarnings(products: OwnedProduct[], children: ChildRow[], intents: CfIntentRow[], wallet: string): SectionState<EarningsData> {
  if (products.length === 0) return { state: "not_launched" };
  const byMint = new Map(products.map((p) => [p.childMint, p]));
  const quote = new Map(children.filter((c) => c.creator_wallet === wallet && byMint.has(c.mint)).map((c) => [c.mint, c.quote_mint]));
  const seen = new Set<string>();
  const rows: EarningRow[] = [];
  let pendingIntents = 0;
  for (const i of intents) {
    const p = byMint.get(i.mint); const q = quote.get(i.mint);
    if (!p || !q) continue; // not this creator's verified child → never shown
    if (i.status === "RESERVED" || i.status === "SIGNED") { pendingIntents++; continue; }
    if (i.status !== "LANDED" || !i.signature || i.finalized_slot === null || !i.distributed_amount || !/^\d+$/.test(i.distributed_amount)) continue;
    if (seen.has(i.idempotency_key)) continue;
    seen.add(i.idempotency_key);
    const dist = BigInt(i.distributed_amount);
    rows.push({ id: i.idempotency_key, creationId: p.creationId, productName: p.name, quoteMint: q, distributedRaw: dist.toString(),
      creatorShareRaw: ((dist * CREATOR_SHARE_BPS) / 10000n).toString(), signature: i.signature, finalizedSlot: Number(i.finalized_slot), at: i.updated_at });
  }
  rows.sort((a, b) => b.finalizedSlot - a.finalizedSlot || a.id.localeCompare(b.id));
  if (rows.length === 0 && pendingIntents === 0) return { state: "no_activity" };
  const t = new Map<string, { s: bigint; n: number }>();
  for (const r of rows) { const c = t.get(r.quoteMint) ?? { s: 0n, n: 0 }; c.s += BigInt(r.creatorShareRaw); c.n++; t.set(r.quoteMint, c); }
  return { state: "ok", data: { rows, pendingIntents, totals: [...t].map(([quoteMint, c]) => ({ quoteMint, creatorShareRaw: c.s.toString(), distributions: c.n })) } };
}

export interface RewardsData { mint: string; rows: DistributionRow[]; solRaw: string; mcpRaw: string; mcpDecimals: number | null }

/** Personal native rewards = the Treasury's finalized payout rows for exactly this wallet. SOL and $MCP stay separate. */
export function buildRewards(mint: string | null, rows: DistributionRow[], wallet: string): SectionState<RewardsData> {
  if (!mint) return { state: "not_launched" };
  const mine = rows.filter((r) => r.recipient === wallet);
  if (mine.length === 0) return { state: "no_activity" };
  let sol = 0n, mcp = 0n; let dec: number | null = null;
  for (const r of mine) { if (r.asset === "SOL") sol += BigInt(r.amountRaw); else { mcp += BigInt(r.amountRaw); dec = r.decimals; } }
  return { state: "ok", data: { mint, rows: mine, solRaw: sol.toString(), mcpRaw: mcp.toString(), mcpDecimals: dec } };
}

/** No persisted execution telemetry exists yet (gateway only writes structured logs). */
export function buildActivity(products: OwnedProduct[]): SectionState<never> {
  if (products.length === 0) return { state: "not_launched" };
  return { state: "not_tracked", reason: "Execution tracking for launched products is prepared but not switched on yet." };
}
