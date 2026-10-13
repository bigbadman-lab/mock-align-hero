// Phase 05-I — deterministic five-minute UTC window → finalized cutoff slot. Pure; RPC is injected.
//
// Boundary convention (CUTOFF_RULE_V1):
//  • Window W = [startUTC, endUTC), end = start + 300. A finalized transaction belongs to W's holdings iff the block
//    it landed in has blockTime < endUTC. Solana timestamps are per BLOCK (second resolution), so every tx in one slot
//    shares one timestamp: a slot is included or excluded whole — same-slot txs can never straddle the boundary.
//  • cutoffSlot = the greatest PRODUCED (non-skipped) finalized slot with blockTime < end, such that the next produced
//    slot has blockTime ≥ end. Holdings at the window end = state after every tx in slots ≤ cutoffSlot.
//  • Skipped slots between cutoff and next are recorded, never selected.
//  • Block time is a stake-weighted estimate and is not guaranteed strictly monotonic. We require monotonic, non-null
//    block times across a guard band of produced blocks on both sides; anything else → HOLD (retry), never a guess.
//  • The finalized head must be ≥ FINALITY_GUARD_SECONDS past end, so a later run selects the SAME slot: the answer
//    depends only on finalized chain data, never on "the newest slot now".
export const CUTOFF_RULE = "CUTOFF_RULE_V1_LAST_PRODUCED_FINALIZED_BLOCKTIME_LT_END" as const;
export const FINALITY_GUARD_SECONDS = 20;
export const GUARD_BLOCKS = 6;
const SEARCH_WINDOW = 64; // produced block must appear within 64 slots of any probe slot (skips are rare runs)

export type CutoffDeps = {
  finalizedHead(): Promise<number | null>;
  /** Produced (non-skipped) finalized slots in [from, to] ascending; null = RPC failure. */
  produced(from: number, to: number): Promise<number[] | null>;
  /** null = block has no time; undefined = RPC failure. */
  blockTime(slot: number): Promise<number | null | undefined>;
};

export type CutoffEvidence = {
  rule: typeof CUTOFF_RULE; windowStart: number; windowEnd: number;
  cutoffSlot: number; cutoffBlockTime: number; nextSlot: number; nextBlockTime: number; skippedBetween: number[];
  guardBefore: [number, number][]; guardAfter: [number, number][];
  finalizedHead: number; finalizedHeadTime: number; rpcCalls: number;
};
export type CutoffResult =
  | { kind: "SELECTED"; evidence: CutoffEvidence }
  | { kind: "HOLD"; reason: "NOT_FINAL_YET" | "RPC_UNKNOWN" | "BLOCK_TIME_MISSING" | "NON_MONOTONIC_BLOCK_TIME" | "NO_PRODUCED_BLOCK" | "SEARCH_BOUNDS"; detail?: string | undefined };

/** 05-I baseline algorithm, kept verbatim as the reference for equivalence tests (05-I.1). */
export async function selectCutoffBaseline(windowStart: number, deps: CutoffDeps): Promise<CutoffResult> {
  if (!Number.isInteger(windowStart) || windowStart % 300 !== 0) throw new Error("WINDOW_NOT_ALIGNED");
  const end = windowStart + 300;
  let calls = 0;
  const hold = (reason: Extract<CutoffResult, { kind: "HOLD" }>["reason"], detail?: string): CutoffResult => ({ kind: "HOLD", reason, detail });
  const bt = async (s: number) => { calls++; return deps.blockTime(s); };
  const prodAtOrAfter = async (s: number): Promise<number | null | undefined> => { calls++; const p = await deps.produced(s, s + SEARCH_WINDOW); if (p === null) return undefined; return p.find((x) => x >= s) ?? null; };

  calls++; const head = await deps.finalizedHead(); if (head === null) return hold("RPC_UNKNOWN", "head");
  const headTime = await bt(head);
  if (headTime === undefined) return hold("RPC_UNKNOWN", "headTime");
  if (headTime === null) return hold("BLOCK_TIME_MISSING", `head:${head}`);
  if (headTime < end + FINALITY_GUARD_SECONDS) return hold("NOT_FINAL_YET");

  // time at the first produced slot ≥ s
  type TA = { e: "RPC_UNKNOWN" | "NO_PRODUCED_BLOCK" | "BLOCK_TIME_MISSING"; p: number; t: number } | { e: null; p: number; t: number };
  const timeAt = async (s: number): Promise<TA> => { const p = await prodAtOrAfter(s); if (p === undefined) return { e: "RPC_UNKNOWN", p: -1, t: -1 }; if (p === null) return { e: "NO_PRODUCED_BLOCK", p: -1, t: -1 };
    const t = await bt(p); if (t === undefined) return { e: "RPC_UNKNOWN", p, t: -1 }; if (t === null) return { e: "BLOCK_TIME_MISSING", p, t: -1 }; return { e: null, p, t }; };

  // lower bound: step back from an estimate until the block time is < end
  let hi = head, lo = Math.max(0, head - Math.ceil((headTime - end) / 0.4) - 500), step = 2000;
  for (let i = 0; ; i++) {
    const r = await timeAt(lo); if (r.e) return hold(r.e, `lo:${lo}`);
    if (r.t < end) break;
    if (i > 20 || lo === 0) return hold("SEARCH_BOUNDS");
    hi = lo; lo = Math.max(0, lo - step); step *= 2;
  }
  // invariant: time(prod≥lo) < end ≤ time(prod≥hi)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await timeAt(mid); if (r.e) return hold(r.e, `mid:${mid}`);
    if (r.t < end) lo = mid; else hi = mid;
  }
  const c = await timeAt(lo), n = await timeAt(hi);
  if (c.e) return hold(c.e); if (n.e) return hold(n.e);
  if (c.p >= n.p || c.t >= end || n.t < end) return hold("NON_MONOTONIC_BLOCK_TIME", "bracket");

  // guard band: GUARD_BLOCKS produced blocks either side must be non-null, monotonic and on the right side of `end`
  calls++; const band = await deps.produced(Math.max(0, c.p - 4 * SEARCH_WINDOW), n.p + 4 * SEARCH_WINDOW);
  if (band === null) return hold("RPC_UNKNOWN", "band");
  const before = band.filter((s) => s <= c.p).slice(-GUARD_BLOCKS - 1), after = band.filter((s) => s >= n.p).slice(0, GUARD_BLOCKS + 1);
  if (before[before.length - 1] !== c.p || after[0] !== n.p) return hold("NON_MONOTONIC_BLOCK_TIME", "band_mismatch");
  const skippedBetween: number[] = []; for (let s = c.p + 1; s < n.p; s++) { if (band.includes(s)) return hold("NON_MONOTONIC_BLOCK_TIME", "produced_between"); skippedBetween.push(s); }
  const times: [number, number][] = [];
  for (const s of [...before, ...after.slice(0)]) { const t = await bt(s); if (t === undefined) return hold("RPC_UNKNOWN", `band:${s}`); if (t === null) return hold("BLOCK_TIME_MISSING", `slot:${s}`); times.push([s, t]); }
  for (let i = 1; i < times.length; i++) if (times[i]![1] < times[i - 1]![1]) return hold("NON_MONOTONIC_BLOCK_TIME", `at:${times[i]![0]}`);
  const gB = times.slice(0, before.length), gA = times.slice(before.length);
  if (gB.some(([, t]) => t >= end) || gA.some(([, t]) => t < end)) return hold("NON_MONOTONIC_BLOCK_TIME", "guard_side");
  return { kind: "SELECTED", evidence: { rule: CUTOFF_RULE, windowStart, windowEnd: end, cutoffSlot: c.p, cutoffBlockTime: c.t, nextSlot: n.p, nextBlockTime: n.t, skippedBetween,
    guardBefore: gB, guardAfter: gA, finalizedHead: head, finalizedHeadTime: headTime, rpcCalls: calls } };
}

export type CutoffHint = { windowStart: number; cutoffSlot: number };

/**
 * 05-I.1 optimized selection. SAME rule and the SAME guard-band proof as the baseline; only the search differs:
 *  • block times are memoized within this one call (never across calls/windows);
 *  • the bracket is seeded from a hint (previous validated frozen cutoff, ~2.5 slots/s) or the head estimate, and is
 *    confirmed from fetched chain data — the hint is never trusted: it only picks where to look first;
 *  • produced slots for the bracket are fetched in ONE getBlocks call and binary-searched by index.
 * Invalid/absent/out-of-order hints fall back to the head estimate; failures still HOLD.
 */
export async function selectCutoff(windowStart: number, deps: CutoffDeps, opts: { hint?: CutoffHint | null } = {}): Promise<CutoffResult & { searchSeed?: "HINT" | "HEAD" }> {
  if (!Number.isInteger(windowStart) || windowStart % 300 !== 0) throw new Error("WINDOW_NOT_ALIGNED");
  const end = windowStart + 300;
  let calls = 0;
  const hold = (reason: Extract<CutoffResult, { kind: "HOLD" }>["reason"], detail?: string): CutoffResult => ({ kind: "HOLD", reason, detail });
  const memo = new Map<number, number | null>();
  const bt = async (s: number) => { if (memo.has(s)) return memo.get(s)!; calls++; const t = await deps.blockTime(s); if (t !== undefined) memo.set(s, t); return t; };

  calls++; const head = await deps.finalizedHead(); if (head === null) return hold("RPC_UNKNOWN", "head");
  const headTime = await bt(head);
  if (headTime === undefined) return hold("RPC_UNKNOWN", "headTime");
  if (headTime === null) return hold("BLOCK_TIME_MISSING", `head:${head}`);
  if (headTime < end + FINALITY_GUARD_SECONDS) return hold("NOT_FINAL_YET");

  const h = opts.hint;
  const hintOk = !!h && Number.isInteger(h.cutoffSlot) && h.cutoffSlot > 0 && h.cutoffSlot < head && h.windowStart % 300 === 0 && h.windowStart < windowStart && windowStart - h.windowStart <= 86_400;
  const seed: "HINT" | "HEAD" = hintOk ? "HINT" : "HEAD";
  const est = hintOk ? h!.cutoffSlot + Math.round((windowStart - h!.windowStart) * 2.5) : head - Math.ceil((headTime - end) / 0.4);
  let width = 48, lo = Math.max(0, est - width), hi = Math.min(head, est + width), P: number[] = [];
  for (let i = 0; ; i++) {
    if (i > 24) return hold("SEARCH_BOUNDS");
    calls++; const got = await deps.produced(lo, hi); if (got === null) return hold("RPC_UNKNOWN", "range");
    P = got.filter((x) => x >= lo && x <= hi);
    if (!P.length) { width *= 2; lo = Math.max(0, lo - width); hi = Math.min(head, hi + width); continue; }
    const t0 = await bt(P[0]!), t1 = await bt(P[P.length - 1]!);
    if (t0 === undefined || t1 === undefined) return hold("RPC_UNKNOWN", "edge");
    if (t0 === null || t1 === null) return hold("BLOCK_TIME_MISSING", "edge");
    if (t0 >= end) { if (lo === 0) return hold("SEARCH_BOUNDS"); width *= 2; lo = Math.max(0, lo - width); continue; }
    if (t1 < end) { if (hi === head) return hold("NON_MONOTONIC_BLOCK_TIME", "head_before_end"); width *= 2; hi = Math.min(head, hi + width); continue; }
    break;
  }
  // invariant over produced indices: t(P[a]) < end <= t(P[b])
  let a = 0, b = P.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1; const t = await bt(P[m]!);
    if (t === undefined) return hold("RPC_UNKNOWN", `mid:${P[m]}`); if (t === null) return hold("BLOCK_TIME_MISSING", `slot:${P[m]}`);
    if (t < end) a = m; else b = m;
  }
  const c = { p: P[a]!, t: (await bt(P[a]!))! }, n = { p: P[b]!, t: (await bt(P[b]!))! };
  if (c.p >= n.p || c.t >= end || n.t < end) return hold("NON_MONOTONIC_BLOCK_TIME", "bracket");
  calls++; const band = await deps.produced(Math.max(0, c.p - 4 * SEARCH_WINDOW), n.p + 4 * SEARCH_WINDOW);
  if (band === null) return hold("RPC_UNKNOWN", "band");
  const before = band.filter((s) => s <= c.p).slice(-GUARD_BLOCKS - 1), after = band.filter((s) => s >= n.p).slice(0, GUARD_BLOCKS + 1);
  if (before[before.length - 1] !== c.p || after[0] !== n.p) return hold("NON_MONOTONIC_BLOCK_TIME", "band_mismatch");
  const skippedBetween: number[] = []; for (let s = c.p + 1; s < n.p; s++) { if (band.includes(s)) return hold("NON_MONOTONIC_BLOCK_TIME", "produced_between"); skippedBetween.push(s); }
  const times: [number, number][] = [];
  for (const s of [...before, ...after]) { const t = await bt(s); if (t === undefined) return hold("RPC_UNKNOWN", `band:${s}`); if (t === null) return hold("BLOCK_TIME_MISSING", `slot:${s}`); times.push([s, t]); }
  for (let i = 1; i < times.length; i++) if (times[i]![1] < times[i - 1]![1]) return hold("NON_MONOTONIC_BLOCK_TIME", `at:${times[i]![0]}`);
  const gB = times.slice(0, before.length), gA = times.slice(before.length);
  if (gB.some(([, t]) => t >= end) || gA.some(([, t]) => t < end)) return hold("NON_MONOTONIC_BLOCK_TIME", "guard_side");
  return { kind: "SELECTED", searchSeed: seed, evidence: { rule: CUTOFF_RULE, windowStart, windowEnd: end, cutoffSlot: c.p, cutoffBlockTime: c.t, nextSlot: n.p, nextBlockTime: n.t, skippedBetween,
    guardBefore: gB, guardAfter: gA, finalizedHead: head, finalizedHeadTime: headTime, rpcCalls: calls } };
}

/** Membership of a tx in window holdings, by the same rule. */
export const inCutoff = (txSlot: number, e: Pick<CutoffEvidence, "cutoffSlot">) => txSlot <= e.cutoffSlot;
