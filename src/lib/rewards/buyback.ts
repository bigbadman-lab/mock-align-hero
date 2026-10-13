// 05-F buyback preparation contract — interfaces and risk checks only. NO venue is integrated; nothing is signed or sent.
// Quote ≠ submitted ≠ confirmed ≠ acquired. Holder $MCP entitlements may only come from a VERIFIED balance delta.
export type Venue = { id: string; programId: string; quote(req: QuoteRequest): Promise<Quote | null> };
export type QuoteRequest = { inputLamports: bigint; outputMint: string; maxSlippageBps: number };
export type Quote = { venueId: string; programIds: string[]; inputLamports: bigint; outAmount: bigint; minOut: bigint; priceImpactBps: number; quotedAtMs: number; route: string };

export type BuybackPolicy = {
  canonicalMint: string | null; venueAllowlist: string[]; programAllowlist: string[];
  maxQuoteAgeMs: number; maxSlippageBps: number; maxPriceImpactBps: number;
  minBudgetLamports: bigint;          // below: carry the budget forward (dust policy)
  feeAndRentLamports: bigint;         // paid by Operations, never from the budget
  operationsAvailable: bigint | null;
};

/** No venue is approved in 05-F. Selection is an explicit future operator decision. */
export const APPROVED_VENUES: readonly Venue[] = [];

export type Prep = { kind: "BLOCKED"; reason: string } | { kind: "CARRY"; reason: "BELOW_MIN_BUDGET" }
  | { kind: "PREPARED_UNSIGNED"; intentId: string; quote: Quote; budgetLamports: bigint };

export function checkQuote(budget: { id: string; lamports: bigint; spent: boolean; approved: boolean }, q: Quote | null, p: BuybackPolicy, nowMs: number): Prep {
  if (!p.canonicalMint) return { kind: "BLOCKED", reason: "CANONICAL_MINT_UNSET" };
  if (!p.venueAllowlist.length) return { kind: "BLOCKED", reason: "VENUE_NOT_SELECTED" };
  if (!budget.approved) return { kind: "BLOCKED", reason: "BUDGET_NOT_APPROVED" };
  if (budget.spent) return { kind: "BLOCKED", reason: "BUDGET_ALREADY_SPENT" };
  if (budget.lamports < p.minBudgetLamports) return { kind: "CARRY", reason: "BELOW_MIN_BUDGET" };
  if (p.operationsAvailable === null) return { kind: "BLOCKED", reason: "OPERATIONS_BALANCE_UNKNOWN" };
  if (p.operationsAvailable < p.feeAndRentLamports) return { kind: "BLOCKED", reason: "OPERATIONS_INSUFFICIENT_FOR_FEES" };
  if (!q) return { kind: "BLOCKED", reason: "NO_ROUTE" };
  if (!p.venueAllowlist.includes(q.venueId)) return { kind: "BLOCKED", reason: "VENUE_NOT_ALLOWLISTED" };
  if (q.programIds.some((x) => !p.programAllowlist.includes(x))) return { kind: "BLOCKED", reason: "PROGRAM_NOT_ALLOWLISTED" };
  if (q.inputLamports !== budget.lamports) return { kind: "BLOCKED", reason: "QUOTE_INPUT_NOT_BUDGET" };
  if (nowMs - q.quotedAtMs > p.maxQuoteAgeMs || q.quotedAtMs > nowMs) return { kind: "BLOCKED", reason: "QUOTE_STALE" };
  if (q.priceImpactBps > p.maxPriceImpactBps) return { kind: "BLOCKED", reason: "PRICE_IMPACT_TOO_HIGH" };
  const floor = (q.outAmount * BigInt(10_000 - p.maxSlippageBps)) / 10_000n;
  if (q.minOut < floor || q.minOut <= 0n) return { kind: "BLOCKED", reason: "MIN_OUT_BELOW_SLIPPAGE_FLOOR" };
  return { kind: "PREPARED_UNSIGNED", intentId: `bb_${budget.id}`, quote: q, budgetLamports: budget.lamports }; // one intent per budget → retries reuse it
}

/** Exact acquired $MCP = finalized post − pre balance of the custody token account in the swap tx. */
export function verifyFill(e: { finalized: boolean; err: unknown; mint: string; custodyAccount: string;
  pre: { account: string; mint: string; amount: bigint } | null; post: { account: string; mint: string; amount: bigint } | null; solSpent: bigint },
  expect: { mint: string; custodyAccount: string; budgetLamports: bigint; minOut: bigint }) {
  if (!e.finalized) return { kind: "UNKNOWN" as const, reason: "NOT_FINALIZED" };
  if (e.err !== null) return { kind: "FAILED" as const, reason: "TX_FAILED" };
  if (!e.post || e.post.account !== expect.custodyAccount || e.post.mint !== expect.mint) return { kind: "UNKNOWN" as const, reason: "CUSTODY_BALANCE_NOT_OBSERVED" };
  const before = e.pre && e.pre.account === expect.custodyAccount && e.pre.mint === expect.mint ? e.pre.amount : 0n;
  const acquired = e.post.amount - before;
  if (acquired <= 0n) return { kind: "FAILED" as const, reason: "NO_TOKENS_ACQUIRED" };
  if (e.solSpent > expect.budgetLamports) return { kind: "MISMATCH" as const, reason: "SPENT_MORE_THAN_BUDGET" };
  if (acquired < expect.minOut) return { kind: "MISMATCH" as const, reason: "BELOW_MIN_OUT" };
  return { kind: "VERIFIED" as const, acquired, solSpent: e.solSpent, unspentLamports: expect.budgetLamports - e.solSpent };
}
