// Creator dashboard projection: pure rules, no I/O. Server route composes these from existing
// authoritative records only (mcp_creations, mcpx_cf_children/intents, Treasury payout projection,
// and — once 0026 is applied — mcpx_tool_activity). Absent or failed data is an explicit state — never a zero.
import type { DistributionRow } from "@/lib/treasury/core";

export const CREATOR_SHARE_BPS = 6000n; // on-chain locked share, re-checked by the keeper before every distribute
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const EARNINGS_PAGE = 20;
export const EARNINGS_TOTALS_SCAN = 2000;
export const ACTIVITY_PAGE = 20;
export const ACTIVITY_RETENTION_DAYS = 90;

export type SectionState<T> =
  | { state: "ok"; data: T }
  | { state: "not_launched" }       // $MCP or the product's token is not live yet
  | { state: "no_activity" }        // tracked, but genuinely no records
  | { state: "not_tracked"; reason: string } // backend for this does not exist yet
  | { state: "unavailable" };       // read failed — show error, never 0

export interface OwnedProduct { creationId: string; slug: string; name: string; childMint: string; verifiedAt: string }

export interface ChildRow { mint: string; quote_mint: string; creator_wallet: string }
export interface CfIntentRow { idempotency_key: string; mint: string; status: string; action: string; signature: string | null; finalized_slot: number | null; distributed_amount: string | null; updated_at: string }

/** Display identity of a quote asset. decimals === null → amounts stay raw and are labelled raw. */
export interface QuoteAsset { mint: string; symbol: string | null; decimals: number | null }

/**
 * Decimals only from trusted sources: wSOL is the native mint (fixed 9 by the protocol); everything else
 * must come from the on-chain mint account (jsonParsed, owned by a token program). Never a guess.
 */
export function resolveQuoteAsset(mint: string, officialMint: string | null, onchainDecimals: Map<string, number>): QuoteAsset {
  if (mint === WSOL_MINT) return { mint, symbol: "SOL", decimals: 9 };
  const d = onchainDecimals.get(mint);
  return { mint, symbol: officialMint && mint === officialMint ? "$MCP" : null, decimals: d ?? null };
}

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
/** Parse getAccountInfo(jsonParsed) for a mint. Anything unexpected → null (shown raw). */
export function parseMintDecimals(value: unknown): number | null {
  const v = value as { owner?: string; data?: { parsed?: { type?: string; info?: { decimals?: unknown } } } } | null;
  if (!v || !v.owner || !TOKEN_PROGRAMS.has(v.owner) || v.data?.parsed?.type !== "mint") return null;
  const d = v.data.parsed.info?.decimals;
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 18 ? d : null;
}

export interface EarningRow {
  id: string; creationId: string; productName: string; quoteMint: string;
  distributedRaw: string; creatorShareRaw: string; signature: string; finalizedSlot: number; at: string;
}
export interface EarningsTotal { quoteMint: string; creatorShareRaw: string; distributions: number }
export interface EarningsData {
  rows: EarningRow[]; totals: EarningsTotal[]; totalsComplete: boolean; pendingIntents: number;
  nextCursor: string | null; assets: Record<string, QuoteAsset>;
}
export interface EarningsPage { rows: EarningRow[]; nextCursor: string | null; assets: Record<string, QuoteAsset> }

// ---- cursor: (finalized_slot desc, idempotency_key asc) ----
const KEY_RE = /^[A-Za-z0-9:_.-]{1,200}$/;
export const encodeCursor = (slot: number, key: string) => `${slot}~${key}`;
export function decodeCursor(raw: string | null): { slot: number; key: string } | null {
  if (!raw || raw.length > 230) return null;
  const i = raw.indexOf("~");
  if (i < 1) return null;
  const slot = Number(raw.slice(0, i)); const key = raw.slice(i + 1);
  return Number.isSafeInteger(slot) && slot >= 0 && KEY_RE.test(key) ? { slot, key } : null;
}

interface Ctx { byMint: Map<string, OwnedProduct>; quote: Map<string, string> }
function ctx(products: OwnedProduct[], children: ChildRow[], wallet: string): Ctx {
  const byMint = new Map(products.map((p) => [p.childMint, p]));
  // Only children whose on-chain-verified 60% recipient is this wallet are ever attributed.
  const quote = new Map(children.filter((c) => c.creator_wallet === wallet && byMint.has(c.mint)).map((c) => [c.mint, c.quote_mint]));
  return { byMint, quote };
}
const confirmed = (i: CfIntentRow) => i.status === "LANDED" && !!i.signature && i.finalized_slot !== null && !!i.distributed_amount && /^\d+$/.test(i.distributed_amount);

function toRows(c: Ctx, intents: CfIntentRow[]): EarningRow[] {
  const seen = new Set<string>(); const rows: EarningRow[] = [];
  for (const i of intents) {
    const p = c.byMint.get(i.mint); const q = c.quote.get(i.mint);
    if (!p || !q || !confirmed(i) || seen.has(i.idempotency_key)) continue; // each confirmed payout once
    seen.add(i.idempotency_key);
    const dist = BigInt(i.distributed_amount!);
    rows.push({ id: i.idempotency_key, creationId: p.creationId, productName: p.name, quoteMint: q, distributedRaw: dist.toString(),
      creatorShareRaw: ((dist * CREATOR_SHARE_BPS) / 10000n).toString(), signature: i.signature!, finalizedSlot: Number(i.finalized_slot), at: i.updated_at });
  }
  return rows.sort((a, b) => b.finalizedSlot - a.finalizedSlot || a.id.localeCompare(b.id));
}

/** One page of confirmed payouts. `fetched` is the DB page (limit pageSize+1) in cursor order. */
export function pageEarnings(products: OwnedProduct[], children: ChildRow[], fetched: CfIntentRow[], wallet: string, pageSize: number, assets: Record<string, QuoteAsset>): EarningsPage {
  const c = ctx(products, children, wallet);
  const more = fetched.length > pageSize;
  const window = fetched.slice(0, pageSize);
  const last = window[window.length - 1];
  return { rows: toRows(c, window), nextCursor: more && last && last.finalized_slot !== null ? encodeCursor(Number(last.finalized_slot), last.idempotency_key) : null, assets };
}

/**
 * Settled creator fees = finalized Pump distributions for the creator's own child mints, where the
 * on-chain sharing config was verified to pay the session wallet 60%. Pump pays shareholders directly
 * (no MCPX custody), so there is no "claimable" balance. Totals are grouped per quote mint, never mixed.
 */
export function buildEarnings(
  products: OwnedProduct[], children: ChildRow[], totalsScan: CfIntentRow[], wallet: string,
  opts: { firstPage?: CfIntentRow[]; pendingIntents?: number; pageSize?: number; assets?: Record<string, QuoteAsset>; scanLimit?: number } = {},
): SectionState<EarningsData> {
  if (products.length === 0) return { state: "not_launched" };
  const c = ctx(products, children, wallet);
  const pageSize = opts.pageSize ?? EARNINGS_PAGE;
  const all = toRows(c, totalsScan);
  // Legacy callers pass mixed statuses in one list; count pending from it when not given separately.
  const pendingIntents = opts.pendingIntents ?? totalsScan.filter((i) => c.quote.has(i.mint) && (i.status === "RESERVED" || i.status === "SIGNED")).length;
  if (all.length === 0 && pendingIntents === 0) return { state: "no_activity" };
  const t = new Map<string, { s: bigint; n: number }>();
  for (const r of all) { const x = t.get(r.quoteMint) ?? { s: 0n, n: 0 }; x.s += BigInt(r.creatorShareRaw); x.n++; t.set(r.quoteMint, x); }
  const assets = opts.assets ?? {};
  const page = opts.firstPage ? pageEarnings(products, children, opts.firstPage, wallet, pageSize, assets) : { rows: all.slice(0, pageSize), nextCursor: null };
  return { state: "ok", data: {
    rows: page.rows, nextCursor: page.nextCursor, pendingIntents, assets,
    totalsComplete: opts.scanLimit === undefined || totalsScan.length < opts.scanLimit,
    totals: [...t].map(([quoteMint, x]) => ({ quoteMint, creatorShareRaw: x.s.toString(), distributions: x.n })),
  } };
}

export interface RewardsData { mint: string; rows: DistributionRow[]; solRaw: string; mcpRaw: string; mcpDecimals: number | null; limited: boolean }

/** Personal native rewards = the Treasury's finalized payout rows for exactly this wallet. SOL and $MCP stay separate. */
export function buildRewards(mint: string | null, rows: DistributionRow[], wallet: string, limited = false): SectionState<RewardsData> {
  if (!mint) return { state: "not_launched" };
  const mine = rows.filter((r) => r.recipient === wallet && !!r.signature && r.finalizedSlot !== null);
  if (mine.length === 0) return { state: "no_activity" };
  let sol = 0n, mcp = 0n; let dec: number | null = null;
  for (const r of mine) { if (r.asset === "SOL") sol += BigInt(r.amountRaw); else { mcp += BigInt(r.amountRaw); dec = r.decimals; } }
  return { state: "ok", data: { mint, rows: mine, solRaw: sol.toString(), mcpRaw: mcp.toString(), mcpDecimals: dec, limited } };
}

// ---- tool activity ----
export interface ActivityRow { id: number; creation_id: string; tool_id: string; outcome: "ok" | "error"; occurred_at: string }
export interface ActivityItem { id: number; creationId: string; productName: string; toolId: string; outcome: "ok" | "error"; at: string }
export interface ActivityData { rows: ActivityItem[]; nextCursor: string | null; retentionDays: number }

export const NOT_TRACKED_REASON = "Execution tracking for launched products is prepared but not switched on yet.";
/** Tracking is reported only when the server has been switched on after the 0026 migration is live. */
export const activityTrackingOn = (flag: string | undefined) => flag === "1";

export function buildActivity(products: OwnedProduct[], tracking = false, fetched: ActivityRow[] = [], pageSize = ACTIVITY_PAGE): SectionState<ActivityData> {
  if (products.length === 0) return { state: "not_launched" };
  if (!tracking) return { state: "not_tracked", reason: NOT_TRACKED_REASON };
  const names = new Map(products.map((p) => [p.creationId, p.name]));
  const owned = fetched.filter((r) => names.has(r.creation_id)); // defence in depth: query is already scoped
  const window = owned.slice(0, pageSize);
  if (window.length === 0) return { state: "no_activity" };
  const last = window[window.length - 1]!;
  return { state: "ok", data: {
    retentionDays: ACTIVITY_RETENTION_DAYS,
    nextCursor: owned.length > pageSize ? `${last.occurred_at}~${last.id}` : null,
    rows: window.map((r) => ({ id: r.id, creationId: r.creation_id, productName: names.get(r.creation_id)!, toolId: r.tool_id, outcome: r.outcome, at: r.occurred_at })),
  } };
}
export function decodeActivityCursor(raw: string | null): { at: string; id: number } | null {
  if (!raw || raw.length > 80) return null;
  const i = raw.lastIndexOf("~"); if (i < 1) return null;
  const at = raw.slice(0, i); const id = Number(raw.slice(i + 1));
  return !Number.isNaN(Date.parse(at)) && /^[0-9T:.+\-Z ]+$/.test(at) && Number.isSafeInteger(id) && id > 0 ? { at, id } : null;
}
