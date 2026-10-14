// TREASURY-01 — pure, browser-safe definitions shared by the home module, /treasury and the public endpoints.
// Integer units only (lamports / raw token units as decimal strings); formatting happens at display time.

export const WINDOW_MS = 5 * 60_000;
export const HEARTBEAT_STALE_MS = 15 * 60_000;
export const SPLIT = { holderSol: 30, buyback: 30, operations: 40 } as const;
export const CHILD_SPLIT = { creator: 60, ops: 25, platform: 15 } as const;

export type Mode = "PRELAUNCH" | "PRODUCTION" | "REHEARSAL";
export type WindowStatus = "NOT_LAUNCHED" | "AWAITING_DATA" | "WINDOW_UPCOMING" | "PROCESSING" | "DELAYED";

export interface MarketSnapshot {
  source: "birdeye" | "dexscreener";
  quote: "USD";
  priceUsd: string | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null; // provider-reported market cap (circulating basis as reported); never FDV
  fdvUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  pairCount: number;
  fetchedAt: string;
}

export interface Overview {
  mode: Mode;
  serverTime: string;
  asOf: string;
  mint: string | null;
  symbol: "$MCP";
  tokenProgram: "token-2022" | "spl-token" | null; // only when proven by a recorded plan/fill
  market: MarketSnapshot | null;
  marketError: string | null;
  supply: { raw: string; decimals: number | null; slot: number; source: "frozen-holder-snapshot" } | null;
  holderCount: { count: number; slot: number; source: "frozen-holder-snapshot" } | null;
  fees: { collectedLamports: string; events: number; lastSlot: number | null } | null;
  allocation: { holderSolLamports: string; buybackLamports: string; operationsLamports: string } | null;
  paid: { solLamports: string; tokenRaw: string; tokenDecimals: number | null; payouts: number } | null;
  buyback: { solSpentLamports: string; tokenAcquiredRaw: string; fills: number } | null;
  windows: {
    status: WindowStatus;
    nextBoundary: string;
    lastProcessed: string | null;
    lastProcessedOutcome: string | null;
    lastFinalizedPayout: string | null;
    heartbeatAt: string | null;
  };
}

export interface WindowRow { windowStart: string; status: string; mode: string; holds: string[]; rewardsLamports: string; operationsLamports: string; label: string }
export interface DistributionRow { id: string; windowStart: string | null; recipient: string; asset: "SOL" | "MCP"; amountRaw: string; decimals: number; signature: string; finalizedSlot: number; batchId: string | null }
export interface ChildEcosystem { verifiedProducts: number; distributions: number; distributedRaw: string | null; lastFinalizedSlot: number | null }

// ---- five-minute UTC windows ----
export function windowStartOf(ms: number) { return Math.floor(ms / WINDOW_MS) * WINDOW_MS; }
export function nextBoundary(ms: number) { return windowStartOf(ms) + WINDOW_MS; }

/** Honest status from server data only. A timer reaching zero never means "paid". */
export function deriveWindowStatus(p: { mint: string | null; now: number; heartbeatAt: number | null; lastProcessedWindow: number | null }): WindowStatus {
  if (!p.mint) return "NOT_LAUNCHED";
  if (p.heartbeatAt === null || p.lastProcessedWindow === null) return "AWAITING_DATA";
  if (p.now - p.heartbeatAt > HEARTBEAT_STALE_MS) return "DELAYED";
  const justClosed = windowStartOf(p.now) - WINDOW_MS; // window that most recently ended
  if (p.lastProcessedWindow >= justClosed) return "WINDOW_UPCOMING";
  if (p.lastProcessedWindow >= justClosed - WINDOW_MS) return "PROCESSING";
  return "DELAYED";
}

export const STATUS_LABEL: Record<WindowStatus, string> = {
  NOT_LAUNCHED: "Not launched",
  AWAITING_DATA: "Awaiting data",
  WINDOW_UPCOMING: "Window upcoming",
  PROCESSING: "Processing",
  DELAYED: "Delayed",
};

/** Countdown display derived from server time; the offset absorbs client clock skew. */
export function countdown(serverOffsetMs: number, clientNow: number) {
  const now = clientNow + serverOffsetMs;
  const left = Math.max(0, nextBoundary(now) - now);
  return { leftMs: left, mm: String(Math.floor(left / 60_000)).padStart(2, "0"), ss: String(Math.floor((left % 60_000) / 1000)).padStart(2, "0") };
}

// ---- integer accounting ----
export function sumRaw(xs: (string | number | bigint | null | undefined)[]): string {
  let t = 0n;
  for (const x of xs) if (x !== null && x !== undefined && String(x) !== "") t += BigInt(String(x).split(".")[0]!);
  return t.toString();
}

/** Display split of a finalized collected amount. Conserves every unit (remainder to operations). */
export function splitNative(collected: bigint) {
  const holderSol = (collected * 30n) / 100n;
  const buyback = (collected * 30n) / 100n;
  return { holderSol, buyback, operations: collected - holderSol - buyback };
}

export function formatUnits(raw: string | null | undefined, decimals: number, maxFrac = 6): string {
  if (raw === null || raw === undefined) return "—";
  const neg = raw.startsWith("-");
  const s = (neg ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(s.length - decimals).slice(0, maxFrac) : "";
  frac = frac.replace(/0+$/, "");
  return (neg ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}
export const lamportsToSol = (raw: string | null | undefined) => formatUnits(raw, 9);

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export const short = (a: string, n = 4) => (a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---- finalized payout projection (only LANDED intents with finalized slot + evidence) ----
export interface IntentLike { idempotency_key: string; kind: string; state: string; signature: string | null; finalized_slot: number | null; evidence: unknown; epoch_start: string | null; plan_rows: unknown; plan_mint: string | null; batch_id: string | null }

export function payoutRows(intents: IntentLike[], p: { mint: string; tokenDecimals: number }): DistributionRow[] {
  const out: DistributionRow[] = [];
  const seen = new Set<string>();
  for (const i of intents) {
    if (i.state !== "LANDED" || !i.signature || i.finalized_slot === null || !i.evidence) continue;
    if (i.kind !== "SOL_PAYOUT" && i.kind !== "TOKEN_PAYOUT") continue;
    if (i.kind === "TOKEN_PAYOUT" && i.plan_mint !== p.mint) continue; // never show another mint's tokens as $MCP
    if (!Array.isArray(i.plan_rows)) continue;
    for (const r of i.plan_rows as { owner?: unknown; amount?: unknown }[]) {
      if (typeof r?.owner !== "string" || typeof r?.amount !== "string" || !B58.test(r.owner) || !/^[1-9]\d*$/.test(r.amount)) continue;
      const id = `${i.idempotency_key}:${r.owner}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, windowStart: i.epoch_start, recipient: r.owner, asset: i.kind === "SOL_PAYOUT" ? "SOL" : "MCP", amountRaw: r.amount,
        decimals: i.kind === "SOL_PAYOUT" ? 9 : p.tokenDecimals, signature: i.signature, finalizedSlot: Number(i.finalized_slot), batchId: i.batch_id });
    }
  }
  return out.sort((a, b) => b.finalizedSlot - a.finalizedSlot || a.id.localeCompare(b.id));
}

export function windowLabel(status: string, holds: string[], rewards: string): string {
  if (status === "HELD") return holds.length ? `Held: ${holds.slice(0, 2).join(", ").toLowerCase().replace(/_/g, " ")}` : "Held";
  if (status === "CANCELLED") return "Cancelled";
  if (rewards === "0") return "No eligible collected fees this window";
  return "Planned from finalized fees";
}
