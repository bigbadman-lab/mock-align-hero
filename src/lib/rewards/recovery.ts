// Phase 05-I.1 — deterministic candidate rebuild for a HELD frozen window. Pure; sources are injected.
// Same rules as 05-I: re-selected finalized cutoff must equal the frozen one, complete history from an empty anchor,
// unique (slot, txIndex) positions, verification against chain state at one finalized slot V, supply at the cutoff
// proven from mint-at-V minus own-program deltas, ownership/eligibility under the frozen record's policy version.
// The candidate is NON-PAYABLE evidence only. A match may later close holds (DB function); a mismatch never can.
import { initIndex, type IndexedTx } from "./holder-index";
import { replayCapturing, freezeSnapshot, type OwnerKind, type FrozenSnapshot } from "./cutoff-snapshot";
import type { CutoffResult, CutoffEvidence } from "./cutoff";
import type { EligibilityPolicy } from "./eligibility-policy";
import type { SupplyProof } from "./supply-proof";

export type RecoveryTx = IndexedTx & { txIndex: number; supplyDelta: bigint | { unknown: string } };
export type FrozenRef = { mint: string; windowStart: number; cutoffSlot: number; digest: string; policyVersion: string; supply: bigint; owners: { owner: string; amount: bigint; class: string }[] };
export type CandidateInput = {
  frozen: FrozenRef; holds: { id: number; reason: string }[]; reselected: CutoffResult;
  history: { anchorSlot: number; V: number; txs: RecoveryTx[]; complete: boolean; chainAtV: Map<string, { owner: string; amount: bigint } | null>; mintSupplyAtV: bigint | null };
  policy: EligibilityPolicy | null; ownerKind: OwnerKind;
};
export type CandidateStatus = "CANDIDATE_MATCH" | "CANDIDATE_MISMATCH" | "CANDIDATE_INCOMPLETE";
export type Candidate = {
  status: CandidateStatus; reason: string | null; candidateDigest: string | null; cutoffSlot: number; holdIds: number[];
  comparison: { originalDigest: string; candidateDigest: string | null; cutoffSlot: number; reselectedCutoffSlot: number | null; originalSupply: string; candidateSupply: string | null;
    holdReasons: string[]; ownerDiffs: { owner: string; original: string; candidate: string }[]; ownerDiffCount: number };
  snapshot: FrozenSnapshot | null;
};

export async function buildCandidate(i: CandidateInput): Promise<Candidate> {
  const f = i.frozen, h = i.history;
  const base = { cutoffSlot: f.cutoffSlot, holdIds: i.holds.map((x) => x.id).sort((a, b) => a - b) };
  const cmp = (cand: FrozenSnapshot | null, resel: number | null) => {
    const o = new Map(f.owners.map((x) => [x.owner, x.amount])), c = new Map((cand?.owners ?? []).map((x) => [x.owner, x.amount]));
    const diffs = [...new Set([...o.keys(), ...c.keys()])].filter((k) => o.get(k) !== c.get(k)).sort()
      .map((k) => ({ owner: k, original: String(o.get(k) ?? 0n), candidate: String(c.get(k) ?? 0n) }));
    return { originalDigest: f.digest, candidateDigest: cand?.digest ?? null, cutoffSlot: f.cutoffSlot, reselectedCutoffSlot: resel, originalSupply: String(f.supply),
      candidateSupply: cand ? String(cand.supplyAtCutoff) : null, holdReasons: i.holds.map((x) => x.reason), ownerDiffs: cand ? diffs.slice(0, 200) : [], ownerDiffCount: cand ? diffs.length : 0 };
  };
  const out = (status: CandidateStatus, reason: string | null, cand: FrozenSnapshot | null, resel: number | null): Candidate =>
    ({ status, reason, candidateDigest: cand?.digest ?? null, ...base, comparison: cmp(cand, resel), snapshot: cand });

  if (i.reselected.kind !== "SELECTED") return out("CANDIDATE_INCOMPLETE", `CUTOFF_UNSTABLE:${i.reselected.reason}`, null, null);
  const ev: CutoffEvidence = i.reselected.evidence;
  if (ev.windowStart !== f.windowStart) return out("CANDIDATE_INCOMPLETE", "WRONG_WINDOW", null, ev.cutoffSlot);
  if (ev.cutoffSlot !== f.cutoffSlot) return out("CANDIDATE_MISMATCH", "CUTOFF_CHANGED", null, ev.cutoffSlot);
  if (!h.complete) return out("CANDIDATE_INCOMPLETE", "MISSING_SOURCE_PAGES", null, ev.cutoffSlot);
  if (h.V < f.cutoffSlot) return out("CANDIDATE_INCOMPLETE", "SOURCE_BEHIND_CUTOFF", null, ev.cutoffSlot);
  if (!i.policy || i.policy.version !== f.policyVersion) return out("CANDIDATE_INCOMPLETE", "POLICY_VERSION_UNAVAILABLE", null, ev.cutoffSlot);
  if (h.txs.some((t) => t.slot > h.V)) return out("CANDIDATE_INCOMPLETE", "TX_BEYOND_V", null, ev.cutoffSlot);

  const s = initIndex(f.mint, { slot: h.anchorSlot, verified: true, accounts: [] });
  const rep = replayCapturing(s, h.txs, [f.cutoffSlot]);
  if ("error" in rep) return out("CANDIDATE_INCOMPLETE", `REPLAY:${rep.error}`, null, ev.cutoffSlot);
  for (const [k, a] of h.chainAtV) {
    const b = s.balances.get(k);
    const bad = a === null ? !!b && b.amount !== 0n : !b || a.amount !== b.amount || a.owner !== b.owner;
    if (bad) return out("CANDIDATE_INCOMPLETE", "VERIFY_AT_V_MISMATCH", null, ev.cutoffSlot);
  }
  for (const [k, b] of s.balances) if (b.amount !== 0n && !h.chainAtV.has(k)) return out("CANDIDATE_INCOMPLETE", "ACCOUNT_NOT_VERIFIED_AT_V", null, ev.cutoffSlot);
  s.coveredTo = h.V;
  let supply: SupplyProof;
  const later = h.txs.filter((t) => t.slot > f.cutoffSlot);
  const unk = later.find((t) => typeof t.supplyDelta !== "bigint");
  if (h.mintSupplyAtV === null) supply = { kind: "UNPROVEN", reason: "ANCHOR_SUPPLY_UNKNOWN" };
  else if (unk) supply = { kind: "UNPROVEN", reason: `UNKNOWN_SUPPLY_IX:${(unk.supplyDelta as { unknown: string }).unknown}` };
  else { const net = later.reduce((x, t) => x + (t.supplyDelta as bigint), 0n); const v = h.mintSupplyAtV - net;
    supply = v < 0n ? { kind: "UNPROVEN", reason: "NEGATIVE_SUPPLY" } : { kind: "PROVEN", cutoffSlot: f.cutoffSlot, supplyAtCutoff: v, anchorSlot: h.V, anchorSupply: h.mintSupplyAtV, laterTxs: later.length, laterNetChange: net, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" }; }
  const st = rep.captured.get(f.cutoffSlot) ?? s;
  const fr = await freezeSnapshot({ state: st, cutoff: ev, supply, checkpointSlot: h.V, gaps: [], policy: i.policy, ownerKind: i.ownerKind });
  if (fr.kind !== "FROZEN") return out("CANDIDATE_INCOMPLETE", fr.reason, null, ev.cutoffSlot);
  return fr.snap.digest === f.digest ? out("CANDIDATE_MATCH", null, fr.snap, ev.cutoffSlot) : out("CANDIDATE_MISMATCH", "FINGERPRINT_DIFFERS", fr.snap, ev.cutoffSlot);
}
