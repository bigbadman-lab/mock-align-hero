// 05-E durable-store tests against a REAL Postgres with the actual migrations applied.
// Runs only when MCPX_TEST_PG_URL points at a throwaway non-production database; skipped otherwise.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { ingestDistribution, processNext, type NativeConfig, type ProcessInput } from "@/lib/rewards/processor";
import { pgStore, type Db } from "@/lib/rewards/store.pg";
import type { Distribution } from "@/lib/rewards/pump-sharing";
import { buildEligibility } from "@/lib/rewards/eligibility";
import { EPOCH_SECONDS } from "@/lib/rewards/epochs";

const URL_ = process.env["MCPX_TEST_PG_URL"];
const d = URL_ ? describe : describe.skip;
const CFG: NativeConfig = { mint: "FIXTURE_MINT", sharingConfig: "FIXTURE_SHARING", rewardsTreasury: "FIXTURE_REWARDS", operationsTreasury: "FIXTURE_OPS", finalityLagSeconds: 30, minPayableLamports: 1n };
const SRC = { programId: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", mint: "FIXTURE_MINT", sharingConfig: "FIXTURE_SHARING", rewardsRecipient: "FIXTURE_REWARDS", operationsRecipient: "FIXTURE_OPS" };
const T0 = 1_800_000_000 - (1_800_000_000 % EPOCH_SECONDS);
const dist = (n: number, r: bigint, op: bigint, t = T0 + 10): Distribution => ({ signature: "5".repeat(80) + String(n).padStart(8, "1"), slot: 100 + n, blockTime: t, ixIndex: 0, eventIndex: 0,
  mint: "FIXTURE_MINT", bondingCurve: "b", sharingConfig: "FIXTURE_SHARING", creatorVault: "v", admin: "a", quoteMint: "11111111111111111111111111111111", distributed: r + op, asset: "SOL",
  receipts: [{ address: "FIXTURE_REWARDS", shareBps: 6000, lamports: r }, { address: "FIXTURE_OPS", shareBps: 4000, lamports: op }] });
const snap = () => buildEligibility({ mint: "FIXTURE_MINT", slot: 200, commitment: "finalized", totalSupply: 4n, source: "fixture",
  accounts: [["alice", 3n], ["bob", 1n]].map(([o, a], i) => ({ account: `acct${i}`, mint: "FIXTURE_MINT", tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", owner: o as string, amount: a as bigint, slot: 200, ownerKind: "WALLET" as const })) },
  { version: "fx-1", approved: true, poolVaults: [], treasuries: [], reserves: [], resolvedOwners: {} });
const run = (workerId: string, over: Partial<ProcessInput> = {}): ProcessInput => ({ workerId, now: T0 + 400, leaseSeconds: 30, finalizedBlockTime: T0 + 400, genesisWindow: T0,
  snapshot: async () => snap(), costs: () => ({ estimateLamports: 1n, reserveLamports: 10n }), ...over });

d("05-E durable store (real Postgres)", () => {
  let a: postgres.Sql, b: postgres.Sql;
  const wrap = (s: postgres.Sql): Db => ({ query: async (t, p) => ({ rows: (await s.unsafe(t, (p ?? []) as never[])) as never }) });
  const reset = async () => {
    // throwaway DB only: disable immutability triggers to wipe between tests
    await a.unsafe(`set session_replication_role = replica; truncate public.mcpx_rw_owner_carry, public.mcpx_rw_receipt_consumption, public.mcpx_rw_window_plans, public.mcpx_rw_sharing_receipts, public.mcpx_rw_proc_runs;
      update public.mcpx_rw_proc_state set watermark = null, lease_owner = null, lease_until = null; set session_replication_role = origin;`);
  };
  beforeAll(async () => { a = postgres(URL_!, { max: 1, onnotice: () => {} }); b = postgres(URL_!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await a?.end(); await b?.end(); });

  it("persists, survives a store/connection restart, and replays to the identical plan", async () => {
    await reset();
    const s1 = pgStore(wrap(a), "worker-A", 30, SRC);
    expect((await ingestDistribution(s1, CFG, dist(1, 600_001n, 400_000n), true)).kind).toBe("CREDITED");
    expect((await ingestDistribution(s1, CFG, dist(1, 600_001n, 400_000n), true)).kind).toBe("DUPLICATE");
    const r1 = await processNext(s1, CFG, run("worker-A")); if (r1.kind !== "SEALED") throw new Error(r1.kind);
    // "restart": a different session/connection with a fresh store object reads durable state
    const s2 = pgStore(wrap(b), "worker-B", 30, SRC);
    expect(await s2.watermark()).toBe(T0);
    const stored = await s2.sealedPlan(T0);
    expect(stored?.planId).toBe(r1.plan.planId);
    expect(stored?.solEntitlements).toEqual([{ owner: "alice", lamports: 225_000n }, { owner: "bob", lamports: 75_000n }]);
    expect(stored?.buybackBudget).toBe(300_001n);
    const r2 = await processNext(s2, CFG, run("worker-B", { now: T0 + 700, finalizedBlockTime: T0 + 700 }));
    expect(r2.kind === "SEALED" && r2.plan.window).toBe(T0 + 300);
  });

  it("two sessions racing for one window: exactly one seals it", async () => {
    await reset();
    const sa = pgStore(wrap(a), "worker-A", 30, SRC), sb = pgStore(wrap(b), "worker-B", 30, SRC);
    await ingestDistribution(sa, CFG, dist(2, 6000n, 4000n), true);
    const [ra, rb] = await Promise.all([processNext(sa, CFG, run("worker-A")), processNext(sb, CFG, run("worker-B"))]);
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds.filter((k) => k === "SEALED")).toHaveLength(1);
    expect((await a.unsafe("select count(*)::int n from public.mcpx_rw_receipt_consumption"))[0]!.n).toBe(1);
  });

  it("stale lease is reclaimed by the DB clock; live lease blocks", async () => {
    await reset();
    expect((await a.unsafe("select public.mcpx_rw_acquire_lease('worker-A', 5) ok"))[0]!.ok).toBe(true);
    expect((await b.unsafe("select public.mcpx_rw_acquire_lease('worker-B', 5) ok"))[0]!.ok).toBe(false);
    await a.unsafe("update public.mcpx_rw_proc_state set lease_until = now() - interval '1 second'");
    expect((await b.unsafe("select public.mcpx_rw_acquire_lease('worker-B', 5) ok"))[0]!.ok).toBe(true);
    // the old holder can no longer commit
    const sa = pgStore(wrap(a), "worker-A", 30, SRC);
    const fake = { planId: "plan_" + "0".repeat(32), inputDigest: "0".repeat(64), window: T0, status: "PLANNED", mode: "DRY_RUN", rewardsTotal: 0n, operationsTotal: 0n, solBudget: 0n, buybackBudget: 0n,
      receiptKeys: [], adjustmentKeys: [], holdReasons: [], solEntitlements: [], solCarriedOut: [], solDust: 0n, buyback: { budgetLamports: 0n }, costs: { estimateLamports: null, reserveLamports: null } } as never;
    expect(await sa.commitWindow(null, fake, new Map())).toBe("LEASE_LOST");
  });

  it("DB refuses forged totals, skipped receipts, double consumption, non-contiguous windows and edits", async () => {
    await reset();
    const sa = pgStore(wrap(a), "worker-A", 30, SRC);
    await ingestDistribution(sa, CFG, dist(3, 6000n, 4000n), true);
    await a.unsafe("select public.mcpx_rw_acquire_lease('worker-A', 30)");
    const key = (await sa.receipts())[0]!.key;
    const base = { planId: "plan_" + "1".repeat(32), inputDigest: "1".repeat(64), status: "HELD", mode: "DRY_RUN", holdReasons: ["X"], snapshotSlot: null };
    const call = (plan: object, own: string[], w = T0, exp: string | null = null) =>
      a.unsafe("select public.mcpx_rw_commit_window('worker-A', $1, $2, $3::text::jsonb, $4::text[], '{}'::text[], '{}'::jsonb, 'test') r", [exp, new Date(w * 1000).toISOString(), JSON.stringify(plan), own] as never[]);
    await expect(call({ ...base, rewardsTotal: "9999", operationsTotal: "4000", solBudget: "3000", buybackBudget: "3000" }, [key])).rejects.toThrow(/plan_totals_mismatch/);
    await expect(call({ ...base, rewardsTotal: "0", operationsTotal: "0", solBudget: "0", buybackBudget: "0" }, [])).rejects.toThrow(/unconsumed_receipt_omitted/);
    await expect(call({ ...base, mode: "LIVE", rewardsTotal: "6000", operationsTotal: "4000", solBudget: "3000", buybackBudget: "3000" }, [key])).rejects.toThrow(/dry_run_only/);
    expect((await call({ ...base, rewardsTotal: "6000", operationsTotal: "4000", solBudget: "3000", buybackBudget: "3000" }, [key]))[0]!.r).toBe("COMMITTED");
    await expect(call({ ...base, planId: "plan_" + "2".repeat(32), rewardsTotal: "6000", operationsTotal: "4000", solBudget: "3000", buybackBudget: "3000" }, [key], T0 + 300, new Date(T0 * 1000).toISOString())).rejects.toThrow(/own_receipt_mismatch|duplicate key/);
    await expect(a.unsafe("update public.mcpx_rw_proc_state set watermark = watermark + interval '900 seconds'")).rejects.toThrow(/watermark_must_advance_one_window/);
    await expect(a.unsafe("update public.mcpx_rw_window_plans set status = 'PLANNED'")).rejects.toThrow(/append_only/);
    await expect(a.unsafe("delete from public.mcpx_rw_sharing_receipts")).rejects.toThrow(/append_only/);
    await expect(a.unsafe("insert into public.mcpx_rw_sharing_receipts select * from public.mcpx_rw_sharing_receipts")).rejects.toThrow(/duplicate key/);
  });

  it("browser roles have no access to any rewards table or function", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(a.begin(async (t) => { await t.unsafe(`set local role ${role}`); await t.unsafe("select * from public.mcpx_rw_window_plans"); })).rejects.toThrow(/permission denied/);
      await expect(a.begin(async (t) => { await t.unsafe(`set local role ${role}`); await t.unsafe("select public.mcpx_rw_acquire_lease('evil-x', 30)"); })).rejects.toThrow(/permission denied/);
    }
  });
});
