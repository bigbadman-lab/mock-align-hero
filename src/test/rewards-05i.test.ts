// Phase 05-I — finalized cutoff anchoring, at-cutoff reconstruction, supply proof, eligibility policy v1. Offline.
import { describe, expect, it } from "vitest";
import { selectCutoff, type CutoffDeps, type CutoffEvidence } from "@/lib/rewards/cutoff";
import { initIndex, type IndexedTx } from "@/lib/rewards/holder-index";
import { replayCapturing, freezeSnapshot, holderBudgetOutcome, pipelineStatus } from "@/lib/rewards/cutoff-snapshot";
import { supplyAtCutoff, supplyDelta, type RawTx } from "@/lib/rewards/supply-proof";
import { POLICY_V1_DRAFT, policyBlockers, policyFor, policyLiveAllowed, type EligibilityPolicy } from "@/lib/rewards/eligibility-policy";

// ---- synthetic finalized chain: slot → blockTime (null = missing), absent = skipped
const W = 1_800_000_000 - (1_800_000_000 % 300); // window start
function chain(times: Map<number, number | null>, head: number, fail?: { produced?: boolean; time?: number }): CutoffDeps {
  return {
    finalizedHead: async () => head,
    produced: async (a, b) => (fail?.produced ? null : [...times.keys()].filter((s) => s >= a && s <= b && s <= head).sort((x, y) => x - y)),
    blockTime: async (s) => (fail?.time === s ? undefined : times.has(s) ? times.get(s)! : null),
  };
}
// 2.5 slots/sec, every 7th slot skipped, starting 2000 slots before the window
function build(base = 100_000, n = 6000, mutate?: (m: Map<number, number | null>) => void) {
  const m = new Map<number, number | null>();
  for (let i = 0; i < n; i++) if (i % 7 !== 3) m.set(base + i, W - 800 + Math.floor(i / 2.5));
  mutate?.(m); return m;
}

describe("05-I cutoff selection (CUTOFF_RULE_V1)", () => {
  it("selects the last produced slot with blockTime < end, records skipped slots, and is stable for a late run", async () => {
    const m = build(); const head = 105_900;
    const r = await selectCutoff(W, chain(m, head));
    expect(r.kind).toBe("SELECTED"); if (r.kind !== "SELECTED") return;
    const e = r.evidence;
    expect(e.cutoffBlockTime).toBeLessThan(W + 300); expect(e.nextBlockTime).toBeGreaterThanOrEqual(W + 300);
    for (const s of e.skippedBetween) expect(m.has(s)).toBe(false);
    // every produced slot ≤ cutoff has time < end; every produced slot ≥ next has time ≥ end
    for (const [s, t] of m) if (t !== null) expect(s <= e.cutoffSlot ? t < W + 300 : s >= e.nextSlot ? t >= W + 300 : false).toBe(true);
    const late = await selectCutoff(W, chain(m, 105_999)); // head moved on: same answer
    expect(late.kind === "SELECTED" && late.evidence.cutoffSlot).toBe(e.cutoffSlot);
    const next = await selectCutoff(W + 300, chain(m, head)); // consecutive window
    expect(next.kind === "SELECTED" && next.evidence.cutoffSlot).toBeGreaterThan(e.cutoffSlot);
  });
  it("holds when the head is not final past the end, block times are missing or non-monotonic, or RPC fails", async () => {
    const m = build();
    expect(await selectCutoff(W, chain(m, 102_760))).toMatchObject({ kind: "HOLD", reason: "NOT_FINAL_YET" });
    const r0 = await selectCutoff(W, chain(m, 105_900)); if (r0.kind !== "SELECTED") throw new Error("x");
    const c = r0.evidence.cutoffSlot;
    expect((await selectCutoff(W, chain(build(undefined, undefined, (x) => x.set(r0.evidence.nextSlot + 1 + ((r0.evidence.nextSlot + 1) % 7 === 3 ? 1 : 0), null)), 105_900))).kind).toBe("HOLD");
    expect(await selectCutoff(W, chain(build(undefined, undefined, (x) => x.set(r0.evidence.nextSlot + (x.has(r0.evidence.nextSlot + 1) ? 1 : 2), W + 299)), 105_900))).toMatchObject({ kind: "HOLD", reason: "NON_MONOTONIC_BLOCK_TIME" });
    expect(await selectCutoff(W, chain(m, 105_900, { produced: true }))).toMatchObject({ kind: "HOLD", reason: "RPC_UNKNOWN" });
    expect(await selectCutoff(W, chain(m, 105_900, { time: c }))).toMatchObject({ kind: "HOLD", reason: "RPC_UNKNOWN" });
  });
  it("rejects unaligned windows", async () => { await expect(selectCutoff(W + 1, chain(build(), 105_900))).rejects.toThrow("WINDOW_NOT_ALIGNED"); });
});

// ---- holder index at cutoffs
const MINT = "MintFixture1111111111111111111111111111111";
const bal = (account: string, owner: string, amount: bigint) => ({ account, owner, mint: MINT, amount });
const tx = (sig: string, slot: number, txIndex: number, pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[]): IndexedTx & { txIndex: number } =>
  ({ signature: sig, slot, txIndex, blockTime: null, finalized: true, failed: false, pre, post });
const T = [
  tx("mint", 10, 0, [], [bal("A1", "alice", 1000n)]),
  tx("t1", 20, 0, [bal("A1", "alice", 1000n)], [bal("A1", "alice", 600n), bal("B1", "bob", 400n)]),
  tx("t2", 30, 1, [bal("B1", "bob", 400n)], [bal("B1", "bob", 100n), bal("A2", "alice", 300n)]),   // same slot as t3
  tx("t3", 30, 2, [bal("A1", "alice", 600n)], [bal("A1", "alice", 500n), bal("D1", "deployer", 100n)]),
  tx("close", 40, 0, [bal("B1", "bob", 100n)], [bal("C1", "carol", 100n)]), // B1 closed, carol opens
];
const ev = (cutoffSlot: number, windowStart = W): CutoffEvidence => ({ rule: "CUTOFF_RULE_V1_LAST_PRODUCED_FINALIZED_BLOCKTIME_LT_END", windowStart, windowEnd: windowStart + 300, cutoffSlot, cutoffBlockTime: windowStart + 299, nextSlot: cutoffSlot + 1, nextBlockTime: windowStart + 300, skippedBetween: [], guardBefore: [], guardAfter: [], finalizedHead: 999, finalizedHeadTime: windowStart + 400, rpcCalls: 0 });
const POLICY: EligibilityPolicy = { ...POLICY_V1_DRAFT, version: "test-elig-v1", status: "TEST_FIXTURE", mint: MINT, deployerWallet: "deployer", poolVaults: [{ address: "pool", evidence: "test fixture" }] };
const wallet = (o: string) => (o === "pda" ? ("PROGRAM" as const) : ("WALLET" as const));
const proven = (slot: number, s = 1000n) => ({ kind: "PROVEN" as const, cutoffSlot: slot, supplyAtCutoff: s, anchorSlot: 50, anchorSupply: s, laterTxs: 0, laterNetChange: 0n, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" as const });

describe("05-I reconstruction at each cutoff", () => {
  it("two consecutive cutoffs reconstruct different holdings; same-slot txs are included whole; later activity never changes an earlier capture", () => {
    const s = initIndex(MINT, { slot: 0, verified: true, accounts: [] });
    const r = replayCapturing(s, T, [25, 35]); if ("error" in r) throw new Error(String(r.error));
    const at25 = Object.fromEntries([...r.captured.get(25)!.balances].map(([k, v]) => [k, v.amount]));
    const at35 = Object.fromEntries([...r.captured.get(35)!.balances].map(([k, v]) => [k, v.amount]));
    expect(at25).toEqual({ A1: 600n, B1: 400n });
    expect(at35).toEqual({ A1: 500n, B1: 100n, A2: 300n, D1: 100n });
    expect(s.balances.has("B1")).toBe(false); // closed after both cutoffs; captures unaffected
    expect(at35['B1']).toBe(100n);
  });
  it("fails closed on a missing page, a conflicting same-slot position, and ignores duplicates", () => {
    const missing = replayCapturing(initIndex(MINT, { slot: 0, verified: true, accounts: [] }), T.filter((t) => t.signature !== "t1"), [35]);
    expect("error" in missing && missing.error).toMatch(/PRE_BALANCE_MISMATCH/);
    const conflict = replayCapturing(initIndex(MINT, { slot: 0, verified: true, accounts: [] }), [...T, { ...T[2]!, signature: "evil" }], [35]);
    expect("error" in conflict && conflict.error).toMatch(/CONFLICTING_SAME_POSITION/);
    const dup = replayCapturing(initIndex(MINT, { slot: 0, verified: true, accounts: [] }), [...T, T[1]!], [35]);
    expect("error" in dup).toBe(false);
  });
});

// ---- supply proof from instructions
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const enc = (b: number[]) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = "1" + s; } return s; };
const le = (v: bigint) => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const raw = (slot: number, ixs: { tag: number; amount?: bigint; mintPos: number }[], inner = false): RawTx => {
  const instructions = ixs.map((i) => ({ programIdIndex: 0, accounts: i.mintPos === 0 ? [1, 2, 3] : [2, 1, 3], data: enc([i.tag, ...le(i.amount ?? 0n)]) }));
  return { slot, transaction: { message: { accountKeys: [T22, MINT, "acct", "auth"], instructions: inner ? [] : instructions } }, meta: { err: null, innerInstructions: inner ? [{ instructions }] : [] } };
};

describe("05-I historical supply at cutoff", () => {
  it("derives supply at the cutoff from the mint account at S minus decoded MintTo/Burn (incl. inner) in (cutoff, S]", () => {
    expect(supplyDelta(raw(60, [{ tag: 8, amount: 25n, mintPos: 1 }]), MINT)).toBe(-25n);
    expect(supplyDelta(raw(61, [{ tag: 14, amount: 7n, mintPos: 0 }], true), MINT)).toBe(7n);
    expect(supplyDelta(raw(62, [{ tag: 3, mintPos: 1 }]), MINT)).toBe(0n);
    const p = supplyAtCutoff(50, { slot: 70, supply: 982n }, [raw(60, [{ tag: 8, amount: 25n, mintPos: 1 }]), raw(61, [{ tag: 14, amount: 7n, mintPos: 0 }], true)], MINT, true);
    expect(p).toMatchObject({ kind: "PROVEN", supplyAtCutoff: 1000n, laterNetChange: -18n });
  });
  it("is UNPROVEN for unknown supply instructions, incomplete history, missing anchor, or out-of-range txs (never assumes today's supply)", () => {
    expect(supplyAtCutoff(50, { slot: 70, supply: 1n }, [raw(60, [{ tag: 39, mintPos: 0 }])], MINT, true)).toMatchObject({ kind: "UNPROVEN", reason: "token_ix_39" });
    expect(supplyAtCutoff(50, { slot: 70, supply: 1n }, [], MINT, false)).toMatchObject({ reason: "MINT_HISTORY_INCOMPLETE" });
    expect(supplyAtCutoff(50, null, [], MINT, true)).toMatchObject({ reason: "ANCHOR_SUPPLY_UNKNOWN" });
    expect(supplyAtCutoff(50, { slot: 70, supply: 1n }, [raw(40, [])], MINT, true)).toMatchObject({ reason: "TX_OUTSIDE_RANGE" });
  });
});

describe("05-I freeze + eligibility policy v1", () => {
  const stateAt = (cut: number, extra: (IndexedTx & { txIndex: number })[] = []) => { const s = initIndex(MINT, { slot: 0, verified: true, accounts: [] }); const r = replayCapturing(s, [...T, ...extra], [cut]); if ("error" in r) throw new Error(String(r.error)); return r.captured.get(cut) ?? s; };
  it("excludes the deployer, aggregates multiple accounts per owner, no minimum balance, and is never live under a test fixture", async () => {
    const f = await freezeSnapshot({ state: stateAt(35), cutoff: ev(35), supply: proven(35), checkpointSlot: 50, gaps: [], policy: POLICY, ownerKind: wallet });
    expect(f.kind).toBe("FROZEN"); if (f.kind !== "FROZEN") return;
    expect(f.snap.owners).toEqual([
      { owner: "alice", amount: 800n, class: "ELIGIBLE", reason: null }, { owner: "bob", amount: 100n, class: "ELIGIBLE", reason: null },
      { owner: "deployer", amount: 100n, class: "EXCLUDED", reason: "native_deployer" }]);
    expect(f.snap.liveAllowed).toBe(false);
    expect(policyBlockers(POLICY)).toContain("TEST_FIXTURE_NEVER_LIVE");
  });
  it("excludes a known pool vault; program-owned balances are AMBIGUOUS and hold settlement", async () => {
    const extra = [tx("p", 45, 0, [bal("A1", "alice", 500n)], [bal("A1", "alice", 200n), bal("PV", "pool", 200n), bal("PD", "pda", 100n)])];
    const f = await freezeSnapshot({ state: stateAt(46, extra), cutoff: ev(46), supply: proven(46), checkpointSlot: 50, gaps: [], policy: POLICY, ownerKind: wallet });
    if (f.kind !== "FROZEN") throw new Error(f.reason);
    expect(f.snap.owners.find((o) => o.owner === "pool")).toMatchObject({ class: "EXCLUDED", reason: "pool_vault" });
    expect(f.snap.owners.find((o) => o.owner === "pda")).toMatchObject({ class: "AMBIGUOUS" });
    expect(f.snap.completeness).toBe("COMPLETE_AMBIGUOUS_HELD");
    expect(holderBudgetOutcome(f.snap, 1000n)).toMatchObject({ kind: "HOLD", carry: 1000n });
  });
  it("holds on supply mismatch, unproven supply, gap, index behind cutoff, missing policy, open repair hold", async () => {
    const base = { state: stateAt(35), cutoff: ev(35), supply: proven(35), checkpointSlot: 50, gaps: [] as { fromSlot: number }[], policy: POLICY, ownerKind: wallet };
    expect(await freezeSnapshot({ ...base, supply: proven(35, 999n) })).toMatchObject({ kind: "ON_HOLD", reason: "SUPPLY_MISMATCH_AT_CUTOFF" });
    expect(await freezeSnapshot({ ...base, supply: { kind: "UNPROVEN", reason: "x" } })).toMatchObject({ reason: "SUPPLY_UNPROVEN:x" });
    expect(await freezeSnapshot({ ...base, gaps: [{ fromSlot: 31 }] })).toMatchObject({ reason: "GAP_OPEN" });
    expect(await freezeSnapshot({ ...base, checkpointSlot: 34 })).toMatchObject({ reason: "INDEX_BEHIND_CUTOFF" });
    expect(await freezeSnapshot({ ...base, policy: null })).toMatchObject({ reason: "NO_POLICY_FOR_WINDOW" });
    expect(await freezeSnapshot({ ...base, heldWindows: new Set([W]) })).toMatchObject({ reason: "REPAIR_HOLD_OPEN" });
    const ownerless = stateAt(35); ownerless.balances.set("X", { owner: null, amount: 0n }); ownerless.balances.get("A1")!.owner = null;
    expect(await freezeSnapshot({ ...base, state: ownerless })).toMatchObject({ reason: "OWNER_UNKNOWN_BALANCE" });
  });
  it("zero eligible holders carries the holder budget forward", async () => {
    const all: EligibilityPolicy = { ...POLICY, version: "test-elig-all", mcpxHoldings: ["alice", "bob"].map((a) => ({ address: a, evidence: "fixture" })) };
    const f = await freezeSnapshot({ state: stateAt(35), cutoff: ev(35), supply: proven(35), checkpointSlot: 50, gaps: [], policy: all, ownerKind: wallet });
    if (f.kind !== "FROZEN") throw new Error(f.reason);
    expect(f.snap.eligibleTotal).toBe(0n);
    expect(holderBudgetOutcome(f.snap, 777n)).toEqual({ kind: "CARRY_FORWARD", carry: 777n, reason: "ZERO_ELIGIBLE_HOLDERS" });
  });
  it("a new policy version applies only from its effective window; earlier frozen digests are unchanged", async () => {
    const v2: EligibilityPolicy = { ...POLICY, version: "test-elig-v2", effectiveFromWindow: W + 300, mcpxHoldings: [{ address: "bob", evidence: "fixture" }] };
    const ps = [POLICY, v2];
    expect(policyFor(W, ps)!.version).toBe("test-elig-v1"); expect(policyFor(W + 300, ps)!.version).toBe("test-elig-v2");
    const a1 = await freezeSnapshot({ state: stateAt(35), cutoff: ev(35), supply: proven(35), checkpointSlot: 50, gaps: [], policy: policyFor(W, ps), ownerKind: wallet });
    const a2 = await freezeSnapshot({ state: stateAt(35), cutoff: ev(35), supply: proven(35), checkpointSlot: 60, gaps: [], policy: policyFor(W, ps), ownerKind: wallet });
    const b = await freezeSnapshot({ state: stateAt(35), cutoff: ev(35, W + 300), supply: proven(35), checkpointSlot: 50, gaps: [], policy: policyFor(W + 300, ps), ownerKind: wallet });
    if (a1.kind !== "FROZEN" || a2.kind !== "FROZEN" || b.kind !== "FROZEN") throw new Error("x");
    expect(a1.snap.digest).toBe(a2.snap.digest); // deterministic replay; later checkpoint doesn't alter the window
    expect(b.snap.owners.find((o) => o.owner === "bob")!.class).toBe("EXCLUDED");
    expect(a1.snap.owners.find((o) => o.owner === "bob")!.class).toBe("ELIGIBLE");
    expect(() => policyFor(W, [POLICY, POLICY])).toThrow("DUPLICATE_POLICY_VERSION");
  });
  it("draft/empty policies and placeholders can never enable live payouts", () => {
    expect(policyLiveAllowed(POLICY_V1_DRAFT)).toBe(false);
    expect(policyBlockers(POLICY_V1_DRAFT)).toEqual(expect.arrayContaining(["POLICY_NOT_APPROVED", "MINT_NOT_SET", "DEPLOYER_NOT_SET", "POOL_ACCOUNTS_NOT_VERIFIED"]));
    expect(policyLiveAllowed({ ...POLICY, status: "APPROVED_FOR_LIVE_PAYOUTS", approvedBy: "x", mintVerifiedAt: "t", poolsVerifiedAt: "t" })).toBe(false); // test- version
  });
  it("pipeline status never reads as live", () => {
    expect(pipelineStatus({ mint: null, openGaps: 0, indexBehind: false, lastWindowHeld: false, policy: null })).toEqual(["WAITING_FOR_MINT", "ELIGIBILITY_UNAPPROVED", "FINANCIAL_EXECUTION_DISABLED"]);
    expect(pipelineStatus({ mint: MINT, openGaps: 1, indexBehind: false, lastWindowHeld: true, policy: POLICY })).toEqual(["HOLDER_HISTORY_INCOMPLETE", "SNAPSHOT_ON_HOLD", "ELIGIBILITY_UNAPPROVED", "FINANCIAL_EXECUTION_DISABLED"]);
    expect(pipelineStatus({ mint: MINT, openGaps: 0, indexBehind: false, lastWindowHeld: false, policy: POLICY })).toEqual(["ELIGIBILITY_UNAPPROVED", "DRY_RUN_READY", "FINANCIAL_EXECUTION_DISABLED"]);
  });
});
