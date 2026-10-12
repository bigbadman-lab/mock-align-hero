// Native $MCP reward economics — pure integer maths, no I/O.
// Applies ONLY to actually collected, confirmed native $MCP creator fees (never trading volume, never child-token fees).
// Child-token 60/25/15 lives in the transaction builder and is unrelated.

export const SPLIT_BPS = { holderSol: 3000n, buyback: 3000n, operations: 4000n } as const;
export const BPS_DENOM = 10_000n;
export const U64_MAX = (1n << 64n) - 1n;

export type Allocation = {
  receiptAmount: bigint;
  carriedIn: bigint;
  holderSol: bigint;
  buyback: bigint;
  operations: bigint;
  residualOut: bigint;
};

/**
 * Split one confirmed receipt (plus the residual carried from the previous allocation) exactly 30/30/40.
 * Each branch is floor((amount+carry) * bps / 10000); whatever the floors leave is carried, never lost.
 * Invariant: holderSol + buyback + operations + residualOut === receiptAmount + carriedIn.
 */
export function allocate(receiptAmount: bigint, carriedIn: bigint): Allocation {
  if (receiptAmount <= 0n || receiptAmount > U64_MAX) throw new Error("receipt_amount_out_of_range");
  if (carriedIn < 0n || carriedIn >= BPS_DENOM) throw new Error("carry_out_of_range");
  const base = receiptAmount + carriedIn;
  const holderSol = (base * SPLIT_BPS.holderSol) / BPS_DENOM;
  const buyback = (base * SPLIT_BPS.buyback) / BPS_DENOM;
  const operations = (base * SPLIT_BPS.operations) / BPS_DENOM;
  const residualOut = base - holderSol - buyback - operations;
  return { receiptAmount, carriedIn, holderSol, buyback, operations, residualOut };
}

/**
 * Split a total among holders pro rata by balance with the largest-remainder method.
 * Deterministic: ties broken by owner address ascending. Sum of shares === total exactly
 * unless total is below one unit per recipient, in which case undistributable units are returned as dust.
 */
export function proRata(total: bigint, balances: readonly { owner: string; amount: bigint }[], minUnit = 1n): { shares: Map<string, bigint>; dust: bigint } {
  if (total < 0n) throw new Error("negative_total");
  const rows = balances.filter((b) => b.amount > 0n);
  const sum = rows.reduce((s, b) => s + b.amount, 0n);
  const shares = new Map<string, bigint>();
  if (sum === 0n || total === 0n) return { shares, dust: total };
  let assigned = 0n;
  const rem: { owner: string; r: bigint }[] = [];
  for (const b of rows) {
    const q = (total * b.amount) / sum;
    shares.set(b.owner, q);
    assigned += q;
    rem.push({ owner: b.owner, r: (total * b.amount) % sum });
  }
  let left = total - assigned;
  rem.sort((a, b) => (a.r === b.r ? (a.owner < b.owner ? -1 : 1) : a.r > b.r ? -1 : 1));
  for (const x of rem) { if (left === 0n) break; shares.set(x.owner, shares.get(x.owner)! + 1n); left -= 1n; }
  // Amounts below the minimum payable unit become dust carried to the next epoch.
  let dust = left;
  for (const [o, v] of shares) if (v < minUnit) { dust += v; shares.delete(o); }
  return { shares, dust };
}
