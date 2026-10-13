// Phase 05-I.1 — recovery + cutoff optimisation. Pure tests always run; DB tests need MCPX_TEST_PG_URL pointing at a
// THROWAWAY local Postgres (127.0.0.1/localhost only). They recreate the public schema there and apply 0009→0011.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { selectCutoff, selectCutoffBaseline, type CutoffDeps, type CutoffEvidence } from "@/lib/rewards/cutoff";
import { initIndex, type IndexedTx } from "@/lib/rewards/holder-index";
import { replayCapturing, freezeSnapshot } from "@/lib/rewards/cutoff-snapshot";
import { buildCandidate, type RecoveryTx, type FrozenRef } from "@/lib/rewards/recovery";
import { POLICY_V1_DRAFT, type EligibilityPolicy } from "@/lib/rewards/eligibility-policy";
import { savePolicy, saveCutoff, commitPass } from "@/lib/rewards/cutoff-snapshot.pg";
import { saveCandidate, resolveWindow, windowPayableForPlanning, loadRecoveryTarget } from "@/lib/rewards/recovery.pg";
import type { Db } from "@/lib/rewards/store.pg";

// ---------- cutoff equivalence (baseline vs optimized) ----------
const W = 1_800_000_000 - (1_800_000_000 % 300);
function chain(times: Map<number, number | null>, head: number, opt: { failTimeAt?: number } = {}): CutoffDeps & { calls: number } {
  const d = { calls: 0,
    finalizedHead: async () => { d.calls++; return head; },
    produced: async (a: number, b: number) => { d.calls++; return [...times.keys()].filter((s) => s >= a && s <= b && s <= head).sort((x, y) => x - y); },
    blockTime: async (s: number) => { d.calls++; return opt.failTimeAt === s ? undefined : times.has(s) ? times.get(s)! : null; } };
  return d;
}
function build(mut?: (m: Map<number, number | null>) => void, n = 9000) {
  const m = new Map<number, number | null>();
  for (let i = 0; i < n; i++) if (i % 7 !== 3 && !(i >= 2746 && i < 2753)) m.set(100_000 + i, W - 800 + Math.floor(i / 2.5)); // regular skips + a skipped run at the boundary
  mut?.(m); return m;
}
const key = (r: Awaited<ReturnType<typeof selectCutoffBaseline>>) => (r.kind === "SELECTED" ? [r.evidence.cutoffSlot, r.evidence.nextSlot, r.evidence.skippedBetween.join(","), JSON.stringify(r.evidence.guardBefore), JSON.stringify(r.evidence.guardAfter)].join("|") : `HOLD:${r.reason}`);

describe("05-I.1 optimized cutoff == baseline", () => {
  const head = 108_901;
  it("identical cutoffs for consecutive windows, with/without hint, and costs fewer calls", async () => {
    const m = build(); let prev: { windowStart: number; cutoffSlot: number } | null = null; const cost: number[][] = [];
    for (let k = 0; k < 6; k++) {
      const w = W + 300 * k;
      const a = chain(m, head), b = chain(m, head), c = chain(m, head);
      const base = await selectCutoffBaseline(w, a), noHint = await selectCutoff(w, b), hinted = await selectCutoff(w, c, { hint: prev });
      expect(key(noHint)).toBe(key(base)); expect(key(hinted)).toBe(key(base));
      expect(base.kind).toBe("SELECTED");
      cost.push([a.calls, b.calls, c.calls]);
      if (base.kind === "SELECTED") prev = { windowStart: w, cutoffSlot: base.evidence.cutoffSlot };
    }
    const sum = (i: number) => cost.reduce((x, r) => x + r[i]!, 0);
    expect(sum(2)).toBeLessThan(sum(0));
  });
  it("skipped run at the boundary is recorded identically", async () => {
    const m = build(); const r = await selectCutoff(W, chain(m, head)); const b = await selectCutoffBaseline(W, chain(m, head));
    expect(r.kind === "SELECTED" ? r.evidence.skippedBetween.length : -1).toBeGreaterThan(0); expect(key(r)).toBe(key(b));
  });
  it("equal-timestamp slots: whole slot run stays on one side", async () => {
    const m = build((x) => { for (const s of [...x.keys()]) if (x.get(s) === W + 299) x.set(s, W + 299); });
    expect(key(await selectCutoff(W, chain(m, head)))).toBe(key(await selectCutoffBaseline(W, chain(m, head))));
  });
  it("invalid, future, misaligned or far hints fall back and still match", async () => {
    const m = build(); const b = key(await selectCutoffBaseline(W + 600, chain(m, head)));
    for (const hint of [{ windowStart: W + 900, cutoffSlot: 1 }, { windowStart: W + 1, cutoffSlot: 101_000 }, { windowStart: W, cutoffSlot: 999_999_999 }, { windowStart: W, cutoffSlot: 100_001 }, { windowStart: W - 300 * 400, cutoffSlot: 100_000 }])
      expect(key(await selectCutoff(W + 600, chain(m, head), { hint }))).toBe(b);
  });
  it("window gap (hint many windows back) still matches", async () => {
    const m = build(); const h = await selectCutoffBaseline(W, chain(m, head)); if (h.kind !== "SELECTED") throw new Error("x");
    expect(key(await selectCutoff(W + 1500, chain(m, head), { hint: { windowStart: W, cutoffSlot: h.evidence.cutoffSlot } }))).toBe(key(await selectCutoffBaseline(W + 1500, chain(m, head))));
  });
  it("both hold on clock regression, missing timestamps, RPC failure and insufficient finality", async () => {
    const r0 = await selectCutoffBaseline(W, chain(build(), head)); if (r0.kind !== "SELECTED") throw new Error("x");
    const n = r0.evidence.nextSlot, after = [...build().keys()].filter((s) => s > n).slice(0, 2);
    const cases: [Map<number, number | null>, number, { failTimeAt?: number }][] = [
      [build((x) => x.set(after[1]!, W + 290)), head, {}],  // regression in guard band
      [build((x) => x.set(after[0]!, null)), head, {}],     // missing time
      [build(), head, { failTimeAt: r0.evidence.cutoffSlot }],
      [build(), 100_000 + 2750 + 30, {}],                   // not final yet
    ];
    for (const [m, hd, o] of cases) {
      const a = await selectCutoffBaseline(W, chain(m, hd, o)), b = await selectCutoff(W, chain(m, hd, o), { hint: { windowStart: W - 300, cutoffSlot: r0.evidence.cutoffSlot - 750 } });
      expect(a.kind).toBe("HOLD"); expect(b.kind).toBe("HOLD"); expect(b.kind === "HOLD" && b.reason).toBe(a.kind === "HOLD" && a.reason);
    }
  });
  it("retry after a transient failure returns the same cutoff", async () => {
    const m = build(); const b = await selectCutoffBaseline(W, chain(m, head)); if (b.kind !== "SELECTED") throw new Error("x");
    const r1 = await selectCutoff(W, chain(m, head, { failTimeAt: b.evidence.nextSlot })); expect(r1).toMatchObject({ kind: "HOLD", reason: "RPC_UNKNOWN" });
    const r2 = await selectCutoff(W, chain(m, head)); expect(key(r2)).toBe(key(b));
  });
});

// ---------- recovery candidates (pure) ----------
const MINT = "MintFixture1111111111111111111111111111111";
const bal = (account: string, owner: string, amount: bigint) => ({ account, owner, mint: MINT, amount });
const tx = (sig: string, slot: number, txIndex: number, pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[]): RecoveryTx =>
  ({ signature: sig, slot, txIndex, blockTime: null, finalized: true, failed: false, pre, post, supplyDelta: 0n });
const TXS: RecoveryTx[] = [
  { ...tx("mint", 10, 0, [], [bal("A1", "alice", 1000n)]), supplyDelta: 1000n },
  tx("t1", 20, 0, [bal("A1", "alice", 1000n)], [bal("A1", "alice", 600n), bal("B1", "bob", 400n)]),
  tx("t2", 40, 0, [bal("B1", "bob", 400n)], [bal("B1", "bob", 100n), bal("C1", "carol", 300n)]),
];
const ev = (cutoffSlot: number, w = W): CutoffEvidence => ({ rule: "CUTOFF_RULE_V1_LAST_PRODUCED_FINALIZED_BLOCKTIME_LT_END", windowStart: w, windowEnd: w + 300, cutoffSlot, cutoffBlockTime: w + 299, nextSlot: cutoffSlot + 1, nextBlockTime: w + 300, skippedBetween: [], guardBefore: [], guardAfter: [], finalizedHead: 999, finalizedHeadTime: w + 400, rpcCalls: 0 });
const POLICY: EligibilityPolicy = { ...POLICY_V1_DRAFT, version: "test-elig-rec", status: "TEST_FIXTURE", mint: MINT, deployerWallet: "deployer" };
const wallet = () => "WALLET" as const;
const chainAtV = () => new Map<string, { owner: string; amount: bigint } | null>([["A1", { owner: "alice", amount: 600n }], ["B1", { owner: "bob", amount: 100n }], ["C1", { owner: "carol", amount: 300n }]]);
async function frozenAt30(): Promise<FrozenRef> {
  const s = initIndex(MINT, { slot: 0, verified: true, accounts: [] }); const r = replayCapturing(s, TXS, [30]); if ("error" in r) throw new Error("x");
  const f = await freezeSnapshot({ state: r.captured.get(30)!, cutoff: ev(30), supply: { kind: "PROVEN", cutoffSlot: 30, supplyAtCutoff: 1000n, anchorSlot: 50, anchorSupply: 1000n, laterTxs: 1, laterNetChange: 0n, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" }, checkpointSlot: 50, gaps: [], policy: POLICY, ownerKind: wallet });
  if (f.kind !== "FROZEN") throw new Error(f.reason);
  return { mint: MINT, windowStart: W, cutoffSlot: 30, digest: f.snap.digest, policyVersion: POLICY.version, supply: 1000n, owners: f.snap.owners };
}
const input = async (over: Partial<Parameters<typeof buildCandidate>[0]> & { h?: Partial<Parameters<typeof buildCandidate>[0]["history"]> } = {}) => {
  const { h, ...rest } = over;
  return { frozen: await frozenAt30(), holds: [{ id: 7, reason: "LATE_PRE_CUTOFF_DATA" }], reselected: { kind: "SELECTED" as const, evidence: ev(30) },
    history: { anchorSlot: 0, V: 50, txs: TXS, complete: true, chainAtV: chainAtV(), mintSupplyAtV: 1000n, ...h }, policy: POLICY, ownerKind: wallet, ...rest };
};

describe("05-I.1 recovery candidate (pure)", () => {
  it("replay match", async () => { const c = await buildCandidate(await input()); expect(c.status).toBe("CANDIDATE_MATCH"); expect(c.comparison.ownerDiffCount).toBe(0); expect(c.holdIds).toEqual([7]); });
  it("replay mismatch (late pre-cutoff tx changes holdings) reports material differences", async () => {
    const late = tx("late", 25, 0, [bal("A1", "alice", 600n)], [bal("A1", "alice", 500n), bal("D1", "dave", 100n)]);
    const t2 = tx("t2", 40, 0, [bal("B1", "bob", 400n)], [bal("B1", "bob", 100n), bal("C1", "carol", 300n)]);
    const cam = chainAtV(); cam.set("A1", { owner: "alice", amount: 500n }); cam.set("D1", { owner: "dave", amount: 100n });
    const c = await buildCandidate(await input({ h: { txs: [TXS[0]!, TXS[1]!, late, t2], chainAtV: cam } }));
    expect(c.status).toBe("CANDIDATE_MISMATCH"); expect(c.reason).toBe("FINGERPRINT_DIFFERS");
    expect(c.comparison.ownerDiffs).toEqual([{ owner: "alice", original: "600", candidate: "500" }, { owner: "dave", original: "0", candidate: "100" }]);
  });
  it("missing source pages", async () => { expect((await buildCandidate(await input({ h: { complete: false } }))).reason).toBe("MISSING_SOURCE_PAGES"); });
  it("missing tx → replay pre-balance mismatch", async () => { expect((await buildCandidate(await input({ h: { txs: [TXS[0]!, TXS[2]!] } }))).reason).toMatch(/REPLAY:PRE_BALANCE_MISMATCH/); });
  it("changed cutoff", async () => { const c = await buildCandidate(await input({ reselected: { kind: "SELECTED", evidence: ev(31) } })); expect(c).toMatchObject({ status: "CANDIDATE_MISMATCH", reason: "CUTOFF_CHANGED" }); });
  it("unstable cutoff", async () => { expect((await buildCandidate(await input({ reselected: { kind: "HOLD", reason: "BLOCK_TIME_MISSING" } }))).reason).toBe("CUTOFF_UNSTABLE:BLOCK_TIME_MISSING"); });
  it("unknown ownership", async () => {
    const t = [{ ...TXS[0]!, post: [{ ...bal("A1", "alice", 1000n), owner: null as unknown as string }] }, ...TXS.slice(1).map((x) => ({ ...x, pre: x.pre.map((p) => ({ ...p })) }))];
    t[1]!.pre = [{ ...bal("A1", "alice", 1000n), owner: null as unknown as string }];
    const two = [t[0]!]; const cam = new Map([["A1", { owner: null as unknown as string, amount: 1000n }]]);
    expect((await buildCandidate(await input({ h: { txs: two, chainAtV: cam } }))).reason).toBe("OWNER_UNKNOWN_BALANCE");
  });
  it("supply mismatch", async () => { expect((await buildCandidate(await input({ h: { mintSupplyAtV: 999n } }))).reason).toBe("SUPPLY_MISMATCH_AT_CUTOFF"); });
  it("duplicate transaction position", async () => { expect((await buildCandidate(await input({ h: { txs: [...TXS, { ...TXS[1]!, signature: "evil" }] } }))).reason).toMatch(/CONFLICTING_SAME_POSITION/); });
  it("verification at V mismatch", async () => { const cam = chainAtV(); cam.set("C1", { owner: "carol", amount: 1n }); expect((await buildCandidate(await input({ h: { chainAtV: cam } }))).reason).toBe("VERIFY_AT_V_MISMATCH"); });
  it("policy version must be the frozen record's", async () => { expect((await buildCandidate(await input({ policy: { ...POLICY, version: "test-other" } }))).reason).toBe("POLICY_VERSION_UNAVAILABLE"); });
});

// ---------- DB semantics (throwaway Postgres only) ----------
const URL_ = process.env["MCPX_TEST_PG_URL"];
const d = URL_ && /127\.0\.0\.1|localhost/.test(URL_) ? describe : describe.skip;
d("05-I.1 recovery DB (throwaway Postgres)", () => {
  let a: postgres.Sql, b: postgres.Sql; let A: Db, B: Db; let frozen: FrozenRef;
  const wrap = (s: postgres.Sql): Db => ({ query: async (t, p) => ({ rows: (await s.unsafe(t, (p ?? []) as never[])) as never }) });
  const holdIds = async () => (await A.query("select id::int id from public.mcpx_rw_hix_holds where resolved_at is null order by id")).rows.map((r) => Number(r.id));
  beforeAll(async () => {
    a = postgres(URL_!, { max: 1, onnotice: () => {} }); b = postgres(URL_!, { max: 1, onnotice: () => {} }); A = wrap(a); B = wrap(b);
    await a.unsafe("drop schema if exists public cascade; create schema public; grant usage on schema public to public;");
    await a.unsafe("do $$ begin create role anon; exception when others then null; end $$; do $$ begin create role authenticated; exception when others then null; end $$; do $$ begin create role service_role; exception when others then null; end $$;");
    for (const f of ["drizzle/migrations/0009_mcpx_05g_holder_index.sql", "docs/pending-migrations/0010_mcpx_05i_cutoff_snapshots.sql", "docs/pending-migrations/0011_mcpx_05i1_recovery.sql"])
      await a.unsafe(readFileSync(f, "utf8").replace(/--> statement-breakpoint/g, ""));
    await savePolicy(A, POLICY);
    await saveCutoff(A, MINT, W, { kind: "SELECTED", evidence: ev(30) });
    frozen = await frozenAt30();
    const s = initIndex(MINT, { slot: 0, verified: true, accounts: [] }); const r = replayCapturing(s, TXS, [30]); if ("error" in r) throw new Error("x");
    const f = await freezeSnapshot({ state: r.captured.get(30)!, cutoff: ev(30), supply: { kind: "PROVEN", cutoffSlot: 30, supplyAtCutoff: 1000n, anchorSlot: 50, anchorSupply: 1000n, laterTxs: 1, laterNetChange: 0n, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" }, checkpointSlot: 50, gaps: [], policy: POLICY, ownerKind: wallet });
    if (f.kind !== "FROZEN") throw new Error(f.reason);
    s.coveredTo = 50;
    expect(await commitPass(A, { state: s, expectedCoveredTo: 0, source: "fixture", txs: TXS, touched: new Set(["A1", "B1", "C1"]), frozen: [{ snap: f.snap, supply: { kind: "PROVEN", cutoffSlot: 30, supplyAtCutoff: 1000n, anchorSlot: 50, anchorSupply: 1000n, laterTxs: 1, laterNetChange: 0n, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" } }], holds: [{ windowStart: W, reason: "LATE_PRE_CUTOFF_DATA" }] })).toBe("COMMITTED");
  });
  afterAll(async () => { await a?.end(); await b?.end(); });

  it("held window is not payable; mismatch candidate can never resolve", async () => {
    expect(await windowPayableForPlanning(A, MINT, W)).toBe(false);
    const t = await loadRecoveryTarget(A, MINT, W); expect(t!.frozen.digest).toBe(frozen.digest);
    const mm = await buildCandidate({ ...(await input()), holds: t!.holds, reselected: { kind: "SELECTED", evidence: ev(31) } });
    const s = await saveCandidate(A, MINT, W, mm, { correlationId: crypto.randomUUID(), operator: "op-test", provenance: { fixture: true } });
    expect(await resolveWindow(A, s.id, "op-test")).toBe("REFUSED_NOT_MATCH");
    expect(await windowPayableForPlanning(A, MINT, W)).toBe(false);
  });
  it("interrupted candidate transaction leaves no partial record", async () => {
    const c = await buildCandidate({ ...(await input()), holds: (await loadRecoveryTarget(A, MINT, W))!.holds });
    const n0 = (await A.query("select count(*)::int n from public.mcpx_rw_hix_recovery_candidates")).rows[0]!.n;
    await expect(saveCandidate(A, MINT, W, c, { correlationId: crypto.randomUUID(), operator: "op-test", provenance: {}, failAfterInsert: true })).rejects.toThrow("SIMULATED_INTERRUPTION");
    expect((await A.query("select count(*)::int n from public.mcpx_rw_hix_recovery_candidates")).rows[0]!.n).toBe(n0);
  });
  it("stale candidate is rejected after a new hold appears; repeated invocation is idempotent", async () => {
    const c = await buildCandidate({ ...(await input()), holds: (await loadRecoveryTarget(A, MINT, W))!.holds });
    const s1 = await saveCandidate(A, MINT, W, c, { correlationId: crypto.randomUUID(), operator: "op-test", provenance: {} });
    const s2 = await saveCandidate(A, MINT, W, c, { correlationId: crypto.randomUUID(), operator: "op-test", provenance: {} });
    expect(s2).toEqual({ id: s1.id, created: false });
    await A.query("insert into public.mcpx_rw_hix_holds (mint, window_start, reason) values ($1,$2,'HOLDER_HISTORY_GAP')", [MINT, new Date(W * 1000).toISOString()]);
    expect(await resolveWindow(A, s1.id, "op-test")).toBe("REFUSED_STALE_CANDIDATE");
  });
  it("concurrent resolutions: exactly one RESOLVED, holds closed once, frozen untouched", async () => {
    const t = (await loadRecoveryTarget(A, MINT, W))!; expect(t.holds.length).toBe(2);
    const c = await buildCandidate({ ...(await input()), holds: t.holds });
    expect(c.status).toBe("CANDIDATE_MATCH");
    const s = await saveCandidate(A, MINT, W, c, { correlationId: crypto.randomUUID(), operator: "op-test", provenance: {} });
    const [r1, r2] = await Promise.all([resolveWindow(A, s.id, "op-a"), resolveWindow(B, s.id, "op-b")]);
    expect([r1, r2].sort()).toEqual(["ALREADY_RESOLVED", "RESOLVED"]);
    expect(await holdIds()).toEqual([]);
    expect((await A.query("select count(*)::int n from public.mcpx_rw_hix_recovery_decisions")).rows[0]!.n).toBe(1);
    expect((await A.query("select digest from public.mcpx_rw_hix_frozen_snapshots")).rows[0]!.digest).toBe(frozen.digest);
    expect(await windowPayableForPlanning(A, MINT, W)).toBe(true); // TEST_FIXTURE policy still keeps live payouts impossible elsewhere
  });
  it("immutability: frozen, candidates, decisions, holds cannot be rewritten or deleted; holds cannot be closed directly", async () => {
    for (const q of ["update public.mcpx_rw_hix_frozen_snapshots set digest='x'", "delete from public.mcpx_rw_hix_frozen_owners", "update public.mcpx_rw_hix_recovery_candidates set status='CANDIDATE_MATCH'",
      "delete from public.mcpx_rw_hix_recovery_decisions", "delete from public.mcpx_rw_hix_holds"]) await expect(a.unsafe(q)).rejects.toThrow(/mcpx_rw/);
    await A.query("insert into public.mcpx_rw_hix_holds (mint, window_start, reason) values ($1,$2,'MANUAL_TEST')", [MINT, new Date(W * 1000).toISOString()]);
    await expect(a.unsafe("update public.mcpx_rw_hix_holds set resolved_at=now(), resolution='manual' where resolved_at is null")).rejects.toThrow(/recorded recovery decision/);
    await expect(a.unsafe("insert into public.mcpx_rw_hix_recovery_candidates (correlation_id,mint,window_start,original_digest,status,cutoff_slot,hold_ids,comparison,provenance,operator,payable) values (gen_random_uuid(),$1,$2,'d','CANDIDATE_INCOMPLETE',30,'{}','{}','{}','x',true)", [MINT, new Date(W * 1000).toISOString()])).rejects.toThrow(/check/);
  });
  it("operator-only: anon/authenticated have no table or function privileges", async () => {
    const r = (await a.unsafe(`select bool_or(has_table_privilege(r, t, 'select') or has_table_privilege(r, t, 'insert')) tp, bool_or(has_function_privilege(r, 'public.mcpx_rw_hix_resolve_window(uuid,text)', 'execute')) fp
      from unnest(array['anon','authenticated']) r, unnest(array['public.mcpx_rw_hix_recovery_candidates','public.mcpx_rw_hix_recovery_decisions','public.mcpx_rw_hix_holds','public.mcpx_rw_hix_frozen_snapshots','public.mcpx_rw_hix_window_cutoffs','public.mcpx_rw_eligibility_policies']) t`))[0]!;
    expect(r.tp).toBe(false); expect(r.fp).toBe(false);
  });
});
