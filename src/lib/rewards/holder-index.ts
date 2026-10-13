// Phase 05-G — finalized-chain holder index (pure core, injectable store). Read-only.
//
// Model: start from a VERIFIED initial balance set at a finalized anchor slot, then apply every finalized
// transaction touching the mint's token accounts, using meta pre/postTokenBalances (authoritative per-account
// balances, independent of instruction kind: Transfer, TransferChecked, MintTo, Burn, CloseAccount, extensions).
// Each tx is applied at most once (signature key). A slot range is "covered" only when the source attests it
// enumerated every signature for every token account of the mint in that range; otherwise it is a GAP.
// Snapshots exist only for slots with continuous coverage from the anchor and an exact supply reconciliation.

export type TokenBal = { account: string; owner: string | null; mint: string; amount: bigint };
export type IndexedTx = { signature: string; slot: number; blockTime: number | null; finalized: boolean; failed: boolean; pre: TokenBal[]; post: TokenBal[] };
export type Coverage = { fromSlot: number; toSlot: number; complete: boolean; source: string };

export type IndexState = {
  mint: string; anchorSlot: number; balances: Map<string, { owner: string | null; amount: bigint }>;
  applied: Set<string>; coveredTo: number; gaps: { fromSlot: number; toSlot: number; reason: string }[];
};

export function initIndex(mint: string, anchor: { slot: number; verified: boolean; accounts: TokenBal[] }): IndexState {
  if (!anchor.verified) throw new Error("ANCHOR_NOT_VERIFIED");
  const balances = new Map<string, { owner: string | null; amount: bigint }>();
  for (const a of anchor.accounts) {
    if (a.mint !== mint) throw new Error("ANCHOR_WRONG_MINT");
    if (balances.has(a.account)) throw new Error("ANCHOR_DUPLICATE_ACCOUNT");
    balances.set(a.account, { owner: a.owner, amount: a.amount });
  }
  return { mint, anchorSlot: anchor.slot, balances, applied: new Set(), coveredTo: anchor.slot, gaps: [] };
}

/** Apply one finalized tx. Idempotent; refuses out-of-coverage, unfinalized, or inconsistent pre-balances. */
export function applyTx(s: IndexState, tx: IndexedTx): "APPLIED" | "DUPLICATE" | "SKIPPED_FAILED" | { error: string } {
  if (!tx.finalized) return { error: "NOT_FINALIZED" };
  if (s.applied.has(tx.signature)) return "DUPLICATE";
  if (tx.slot <= s.anchorSlot) return { error: "BEFORE_ANCHOR" };
  if (tx.failed) { s.applied.add(tx.signature); return "SKIPPED_FAILED"; } // failed txs change no token balances
  const pre = tx.pre.filter((b) => b.mint === s.mint), post = tx.post.filter((b) => b.mint === s.mint);
  for (const p of pre) {
    const cur = s.balances.get(p.account)?.amount ?? 0n;
    if (cur !== p.amount) return { error: `PRE_BALANCE_MISMATCH:${p.account}` }; // missed history → stop, never guess
  }
  const touched = new Set([...pre.map((b) => b.account), ...post.map((b) => b.account)]);
  for (const a of touched) {
    const p = post.find((b) => b.account === a);
    if (!p) s.balances.delete(a); // closed account
    else s.balances.set(a, { owner: p.owner, amount: p.amount });
  }
  s.applied.add(tx.signature);
  return "APPLIED";
}

/** Record source coverage. Non-contiguous or incomplete ranges become gaps that block snapshots after them. */
export function recordCoverage(s: IndexState, c: Coverage) {
  if (c.fromSlot > s.coveredTo + 1) s.gaps.push({ fromSlot: s.coveredTo + 1, toSlot: c.fromSlot - 1, reason: "UNCOVERED_RANGE" });
  if (!c.complete) { s.gaps.push({ fromSlot: c.fromSlot, toSlot: c.toSlot, reason: `INCOMPLETE_SOURCE:${c.source}` }); return; }
  if (s.gaps.length === 0) s.coveredTo = Math.max(s.coveredTo, c.toSlot);
}

/** Gaps can only be cleared by a complete replay of exactly that range (caller re-applies its txs). */
export function repairGap(s: IndexState, gap: { fromSlot: number; toSlot: number }, replay: Coverage) {
  if (!replay.complete || replay.fromSlot > gap.fromSlot || replay.toSlot < gap.toSlot) return false;
  s.gaps = s.gaps.filter((g) => !(g.fromSlot === gap.fromSlot && g.toSlot === gap.toSlot));
  if (s.gaps.length === 0) s.coveredTo = Math.max(s.coveredTo, replay.toSlot);
  return true;
}

export type HolderSnapshot =
  | { kind: "SNAPSHOT"; slot: number; owners: { owner: string; amount: bigint }[]; ownerless: bigint; total: bigint }
  | { kind: "BLOCKED"; reason: string };

/** Owner-aggregated snapshot at `slot`, only if covered and the indexed sum equals finalized supply at that slot. */
export function snapshotAt(s: IndexState, slot: number, finalizedSupplyAtSlot: bigint | null): HolderSnapshot {
  if (s.gaps.some((g) => g.fromSlot <= slot)) return { kind: "BLOCKED", reason: "GAP_BEFORE_SLOT" };
  if (slot > s.coveredTo) return { kind: "BLOCKED", reason: "NOT_COVERED_YET" };
  if (finalizedSupplyAtSlot === null) return { kind: "BLOCKED", reason: "SUPPLY_UNKNOWN" };
  const agg = new Map<string, bigint>(); let ownerless = 0n, total = 0n;
  for (const b of s.balances.values()) {
    total += b.amount;
    if (b.amount === 0n) continue;
    if (!b.owner) { ownerless += b.amount; continue; }
    agg.set(b.owner, (agg.get(b.owner) ?? 0n) + b.amount);
  }
  if (total !== finalizedSupplyAtSlot) return { kind: "BLOCKED", reason: "SUPPLY_MISMATCH" };
  if (ownerless > 0n) return { kind: "BLOCKED", reason: "OWNER_UNKNOWN_BALANCE" };
  const owners = [...agg].map(([owner, amount]) => ({ owner, amount })).sort((a, b) => (a.owner < b.owner ? -1 : 1));
  return { kind: "SNAPSHOT", slot, owners, ownerless, total };
}

/** Current verdict on production sources (05-G probe). Standard RPC cannot attest complete per-mint coverage. */
export const SOURCE_VERDICT = {
  status: "HOLDER_HISTORY_SOURCE_BLOCKED" as const,
  missing: "A source that attests every finalized transaction touching any token account of a mint (incl. accounts created and closed between polls). getSignaturesForAddress(mint) misses plain Transfer instructions that do not reference the mint; getProgramAccounts is current-state only.",
  simplestFix: "Paid RPC with a Geyser/stream or token-account-history API (e.g. Helius/Triton) started at the $MCP creation slot, persisted through this index with gap detection.",
};
