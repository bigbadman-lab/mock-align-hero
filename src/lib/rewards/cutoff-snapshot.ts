// Phase 05-I — freeze an immutable holder snapshot for one five-minute window at its finalized cutoff slot. Pure.
// Inputs must all refer to the SAME cutoff: index state after exactly the txs with slot ≤ cutoff, a supply proven at
// that cutoff (supply-proof.ts), a gap-free index checkpoint ≥ cutoff, and the policy version in force for the window.
import { applyTx, type IndexState, type IndexedTx } from "./holder-index";
import { buildEligibility, type EligibilitySnapshot, type HolderAccount } from "./eligibility";
import { toExclusionConfig, policyLiveAllowed, type EligibilityPolicy } from "./eligibility-policy";
import type { CutoffEvidence } from "./cutoff";
import type { SupplyProof } from "./supply-proof";

export type OwnerKind = (owner: string) => HolderAccount["ownerKind"];

export type FrozenSnapshot = {
  mint: string; windowStart: number; cutoffSlot: number; checkpointSlot: number; policyVersion: string; policyStatus: EligibilityPolicy["status"];
  supplyAtCutoff: bigint; indexedTotal: bigint; accounts: number; digest: string;
  owners: { owner: string; amount: bigint; class: "ELIGIBLE" | "EXCLUDED" | "AMBIGUOUS"; reason: string | null }[];
  eligibleTotal: bigint; excludedTotal: bigint; ambiguousTotal: bigint; liveAllowed: boolean;
  completeness: "COMPLETE" | "COMPLETE_AMBIGUOUS_HELD";
};
export type FreezeResult = { kind: "FROZEN"; snap: FrozenSnapshot; eligibility: EligibilitySnapshot } | { kind: "ON_HOLD"; reason: string };

export function cloneIndex(s: IndexState): IndexState {
  return { ...s, balances: new Map([...s.balances].map(([k, v]) => [k, { ...v }])), applied: new Set(s.applied), gaps: s.gaps.map((g) => ({ ...g })) };
}

/**
 * Replay `txs` (must be the complete set in chain order) and capture an independent state copy at each cutoff slot.
 * A state is captured only after ALL txs with slot ≤ cutoff have been applied, before the first tx with slot > cutoff.
 */
export function replayCapturing(s: IndexState, txs: readonly (IndexedTx & { txIndex: number })[], cutoffs: readonly number[]) {
  const sorted = [...txs].sort((a, b) => a.slot - b.slot || a.txIndex - b.txIndex);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.slot === sorted[i - 1]!.slot && sorted[i]!.txIndex === sorted[i - 1]!.txIndex && sorted[i]!.signature !== sorted[i - 1]!.signature)
    return { error: `CONFLICTING_SAME_POSITION:${sorted[i]!.slot}:${sorted[i]!.txIndex}` } as const;
  const want = [...new Set(cutoffs)].sort((a, b) => a - b), captured = new Map<number, IndexState>();
  let k = 0;
  for (const t of sorted) {
    while (k < want.length && t.slot > want[k]!) { captured.set(want[k]!, cloneIndex(s)); k++; }
    const r = applyTx(s, t);
    if (typeof r === "object") return { error: r.error } as const;
  }
  return { captured, pendingCutoffs: want.slice(k) } as const; // pending: cutoffs ≥ last tx slot, captured by caller at end
}

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function freezeSnapshot(a: {
  state: IndexState; cutoff: CutoffEvidence; supply: SupplyProof; checkpointSlot: number; gaps: { fromSlot: number }[];
  policy: EligibilityPolicy | null; ownerKind: OwnerKind; heldWindows?: Set<number>;
}): Promise<FreezeResult> {
  const { state: s, cutoff: c } = a;
  if (a.heldWindows?.has(c.windowStart)) return { kind: "ON_HOLD", reason: "REPAIR_HOLD_OPEN" };
  if (!a.policy) return { kind: "ON_HOLD", reason: "NO_POLICY_FOR_WINDOW" };
  if (a.checkpointSlot < c.cutoffSlot) return { kind: "ON_HOLD", reason: "INDEX_BEHIND_CUTOFF" };
  if (a.gaps.some((g) => g.fromSlot <= a.checkpointSlot)) return { kind: "ON_HOLD", reason: "GAP_OPEN" };
  if (a.supply.kind !== "PROVEN") return { kind: "ON_HOLD", reason: `SUPPLY_UNPROVEN:${a.supply.reason}` };
  if (a.supply.cutoffSlot !== c.cutoffSlot) return { kind: "ON_HOLD", reason: "SUPPLY_FOR_OTHER_SLOT" };
  let total = 0n; const accounts: HolderAccount[] = [];
  for (const [account, b] of s.balances) {
    total += b.amount;
    if (b.amount === 0n) continue;
    if (!b.owner) return { kind: "ON_HOLD", reason: "OWNER_UNKNOWN_BALANCE" };
    accounts.push({ account, mint: s.mint, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", owner: b.owner, amount: b.amount, slot: c.cutoffSlot, ownerKind: a.ownerKind(b.owner) });
  }
  if (total !== a.supply.supplyAtCutoff) return { kind: "ON_HOLD", reason: "SUPPLY_MISMATCH_AT_CUTOFF" };
  const el = buildEligibility({ mint: s.mint, slot: c.cutoffSlot, commitment: "finalized", totalSupply: a.supply.supplyAtCutoff, accounts, source: "hix:replay@cutoff" }, toExclusionConfig(a.policy));
  if (el.status !== "COMPLETE") return { kind: "ON_HOLD", reason: `ELIGIBILITY_${el.status}:${el.reasons.join(",")}` };
  const owners = [
    ...el.holders.map((h) => ({ owner: h.owner, amount: h.amount, class: "ELIGIBLE" as const, reason: null })),
    ...el.excluded.map((h) => ({ owner: h.owner, amount: h.amount, class: "EXCLUDED" as const, reason: h.why })),
    ...el.ambiguous.map((h) => ({ owner: h.owner, amount: h.amount, class: "AMBIGUOUS" as const, reason: h.why })),
  ].sort((x, y) => (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
  const canon = JSON.stringify([s.mint, c.windowStart, c.cutoffSlot, a.policy.version, String(a.supply.supplyAtCutoff), owners.map((o) => [o.owner, String(o.amount), o.class, o.reason])]);
  const snap: FrozenSnapshot = {
    mint: s.mint, windowStart: c.windowStart, cutoffSlot: c.cutoffSlot, checkpointSlot: a.checkpointSlot, policyVersion: a.policy.version, policyStatus: a.policy.status,
    supplyAtCutoff: a.supply.supplyAtCutoff, indexedTotal: total, accounts: accounts.length, digest: await sha256Hex(canon), owners,
    eligibleTotal: el.eligibleTotal, excludedTotal: el.excludedTotal, ambiguousTotal: el.ambiguousTotal,
    liveAllowed: el.livePayoutAllowed && policyLiveAllowed(a.policy), completeness: el.ambiguous.length ? "COMPLETE_AMBIGUOUS_HELD" : "COMPLETE",
  };
  return { kind: "FROZEN", snap, eligibility: el };
}

/** Zero eligible holders (everything excluded) → the holder budget carries forward; nobody is invented. */
export function holderBudgetOutcome(snap: Pick<FrozenSnapshot, "eligibleTotal" | "completeness">, budget: bigint) {
  if (snap.completeness !== "COMPLETE") return { kind: "HOLD" as const, carry: budget, reason: "AMBIGUOUS_HOLDINGS" };
  if (snap.eligibleTotal === 0n) return { kind: "CARRY_FORWARD" as const, carry: budget, reason: "ZERO_ELIGIBLE_HOLDERS" };
  return { kind: "DISTRIBUTE" as const, carry: 0n, reason: null };
}

export type PipelineStatus = "DRY_RUN_READY" | "WAITING_FOR_MINT" | "HOLDER_HISTORY_INCOMPLETE" | "SNAPSHOT_ON_HOLD" | "ELIGIBILITY_UNAPPROVED" | "FINANCIAL_EXECUTION_DISABLED";
/** Never returns anything that reads as "live": FINANCIAL_EXECUTION_DISABLED is always present in this phase. */
export function pipelineStatus(i: { mint: string | null; openGaps: number; indexBehind: boolean; lastWindowHeld: boolean; policy: EligibilityPolicy | null }): PipelineStatus[] {
  const out: PipelineStatus[] = [];
  if (!i.mint) out.push("WAITING_FOR_MINT");
  else {
    if (i.openGaps > 0 || i.indexBehind) out.push("HOLDER_HISTORY_INCOMPLETE");
    if (i.lastWindowHeld) out.push("SNAPSHOT_ON_HOLD");
  }
  if (!i.policy || !policyLiveAllowed(i.policy)) out.push("ELIGIBILITY_UNAPPROVED");
  if (i.mint && !out.includes("HOLDER_HISTORY_INCOMPLETE") && !out.includes("SNAPSHOT_ON_HOLD")) out.push("DRY_RUN_READY");
  out.push("FINANCIAL_EXECUTION_DISABLED");
  return out;
}
