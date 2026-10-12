// 05-D processor tests. Every address below is a FIXTURE label, never a production value.
import { describe, expect, it } from "vitest";
import { ingestDistribution, processNext, memoryStore, holderSplit, transitionPlan, allocateFill, reconcile, configBlockers, type NativeConfig, type ProcessInput } from "@/lib/rewards/processor";
import { decodeSharing, splitRewardsReceipt, type Distribution } from "@/lib/rewards/pump-sharing";
import { buildEligibility, type ExclusionConfig } from "@/lib/rewards/eligibility";
import { EPOCH_SECONDS } from "@/lib/rewards/epochs";
import big from "./fixtures/pump-sharing/sh_4S2UVibM.json";
import amm from "./fixtures/pump-sharing/sh_GsBaY54o.json";

const CFG: NativeConfig = { mint: "FIXTURE_MINT", sharingConfig: "FIXTURE_SHARING", rewardsTreasury: "FIXTURE_REWARDS", operationsTreasury: "FIXTURE_OPS", finalityLagSeconds: 30, minPayableLamports: 1000n };
const T0 = 1_800_000_000 - (1_800_000_000 % EPOCH_SECONDS);
const SIG = (n: number) => "5".repeat(80) + String(n).padStart(8, "1");
const dist = (o: Partial<Distribution> & { r: bigint; op: bigint; n?: number; ix?: number }): Distribution => ({
  signature: SIG(o.n ?? 1), slot: 100, blockTime: T0 + 10, ixIndex: o.ix ?? 0, eventIndex: 0, mint: "FIXTURE_MINT", bondingCurve: "b", sharingConfig: "FIXTURE_SHARING",
  creatorVault: "v", admin: "a", quoteMint: "11111111111111111111111111111111", distributed: o.r + o.op, asset: "SOL",
  receipts: [{ address: "FIXTURE_REWARDS", shareBps: 6000, lamports: o.r }, { address: "FIXTURE_OPS", shareBps: 4000, lamports: o.op }], ...o,
});
const policy: ExclusionConfig = { version: "fx-1", approved: true, poolVaults: [], treasuries: [], reserves: [], resolvedOwners: {} };
const snapOf = (h: [string, bigint][], cfg = policy) => buildEligibility({ mint: "FIXTURE_MINT", slot: 200, commitment: "finalized", totalSupply: h.reduce((s, x) => s + x[1], 0n), source: "fixture",
  accounts: h.map(([o, a], i) => ({ account: `acct${i}`, mint: "FIXTURE_MINT", tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", owner: o, amount: a, slot: 200, ownerKind: "WALLET" as const })) }, cfg);
const run = (over: Partial<ProcessInput> = {}): ProcessInput => ({ workerId: "w1", now: T0 + 400, leaseSeconds: 60, finalizedBlockTime: T0 + 400, genesisWindow: T0,
  snapshot: async () => snapOf([["alice", 3n], ["bob", 1n]]), costs: () => ({ estimateLamports: 10_000n, reserveLamports: 1_000_000n }), ...over });

describe("05-D arithmetic", () => {
  it("60/40 then 50/50 → 30/30/40; odd lamport to buyback; nothing invented", () => {
    expect(splitRewardsReceipt(600_001n)).toEqual({ solPayout: 300_000n, buyback: 300_001n, oddLamport: 1n });
    const total = 1_000_003n, r = (total * 6000n) / 10000n, s = splitRewardsReceipt(r);
    expect(s.solPayout + s.buyback).toBe(r);
  });
  it("many holders + tiny budget: exact conservation, per-owner carry, no owner twice", () => {
    const holders = Array.from({ length: 500 }, (_, i) => ({ owner: `h${String(i).padStart(3, "0")}`, amount: BigInt(i + 1) }));
    const r = holderSplit(12_345n, holders, new Map(), 100n);
    const sum = [...r.paid, ...r.carried].reduce((s, x) => s + x.lamports, 0n) + r.dust;
    expect(sum).toBe(12_345n);
    expect(new Set([...r.paid, ...r.carried].map((x) => x.owner)).size).toBe(r.paid.length + r.carried.length);
    expect(r.carried.length).toBeGreaterThan(0);
  });
  it("carried amount is added to the same owner next time", () => {
    const r = holderSplit(10n, [{ owner: "a", amount: 1n }], new Map([["a", 995n]]), 1000n);
    expect(r.paid).toEqual([{ owner: "a", lamports: 1005n }]);
  });
});

describe("05-D ingestion trust", () => {
  it("no real treasuries configured → rejected/BLOCKED", async () => {
    const c = { ...CFG, rewardsTreasury: null, operationsTreasury: null, mint: null, sharingConfig: null };
    expect(configBlockers(c)).toEqual(["NATIVE_MINT_UNSET", "SHARING_CONFIG_UNSET", "REWARDS_TREASURY_UNSET", "OPERATIONS_TREASURY_UNSET"]);
    expect(await ingestDistribution(memoryStore(), c, dist({ r: 6n, op: 4n }), true)).toEqual({ kind: "REJECTED", reason: "NATIVE_MINT_UNSET" });
  });
  it("wrong mint / PDA / recipient / unfinalized rejected", async () => {
    const s = memoryStore();
    expect((await ingestDistribution(s, CFG, dist({ r: 6n, op: 4n, mint: "OTHER" }), true))).toMatchObject({ reason: "wrong_mint" });
    expect((await ingestDistribution(s, CFG, dist({ r: 6n, op: 4n, sharingConfig: "OTHER" }), true))).toMatchObject({ reason: "wrong_sharing_config" });
    const bad = dist({ r: 6n, op: 4n }); bad.receipts[0]!.address = "ATTACKER";
    expect((await ingestDistribution(s, CFG, bad, true))).toMatchObject({ reason: "rewards_share_not_6000" });
    expect((await ingestDistribution(s, CFG, dist({ r: 6n, op: 4n }), false))).toMatchObject({ reason: "not_finalized" });
  });
  it("real mainnet distribution (non-$MCP) cannot be credited", async () => {
    const d = await decodeSharing(big as never); if (d.kind !== "OK") throw new Error();
    expect((await ingestDistribution(memoryStore(), CFG, d.distributions[0]!, true)).kind).toBe("REJECTED");
  });
  it("internal PumpSwap sweep is never a distribution input", async () => {
    const d = await decodeSharing(amm as never); if (d.kind !== "OK") throw new Error();
    expect(d.sweeps.length).toBe(1); expect(d.distributions.length).toBe(1); // only the distribution can be offered to ingest
  });
  it("many receipts in one tx; duplicates and two racing scanners count once", async () => {
    const s = memoryStore();
    const a = dist({ r: 600n, op: 400n, ix: 0 }), b = dist({ r: 601n, op: 400n, ix: 1 });
    const out = await Promise.all([a, b, a, b, a].map((x) => ingestDistribution(s, CFG, x, true)));
    expect(out.filter((o) => o.kind === "CREDITED").length).toBe(2);
    expect((await s.receipts()).length).toBe(2);
  });
});

describe("05-D processor", () => {
  it("seals a window as DRY_RUN HELD plan with exact budgets; never executable", async () => {
    const s = memoryStore();
    await ingestDistribution(s, CFG, dist({ r: 600_001n, op: 400_000n }), true);
    const r = await processNext(s, CFG, run()); if (r.kind !== "SEALED") throw new Error(r.kind);
    const p = r.plan;
    expect(p).toMatchObject({ mode: "DRY_RUN", status: "HELD", rewardsTotal: 600_001n, operationsTotal: 400_000n, solBudget: 300_000n, buybackBudget: 300_001n, executionId: null });
    expect(p.solEntitlements).toEqual([{ owner: "alice", lamports: 225_000n }, { owner: "bob", lamports: 75_000n }]);
    expect(p.buyback.tokenEntitlements).toBeNull();
    expect(p.holdReasons).toContain("EXECUTION_NOT_APPROVED");
    expect(() => transitionPlan(p, "PLANNED")).not.toThrow();
    expect(() => transitionPlan({ ...p, status: "PLANNED" }, "APPROVED")).toThrow("EXECUTION_NOT_APPROVED");
    expect(() => transitionPlan({ ...p, status: "CANCELLED" }, "PLANNED")).toThrow(/illegal/);
  });
  it("zero-fee window sealed as zero plan with no snapshot read", async () => {
    let called = false;
    const r = await processNext(memoryStore(), CFG, run({ snapshot: async () => { called = true; return null; } }));
    expect(r.kind === "SEALED" && r.plan.rewardsTotal).toBe(0n); expect(called).toBe(false);
  });
  it("cycle boundary + finality lag + schedule drift: not due until end+lag on both clocks; one window per call", async () => {
    const s = memoryStore();
    expect(await processNext(s, CFG, run({ now: T0 + 329, finalizedBlockTime: T0 + 400 }))).toEqual({ kind: "NOT_DUE", nextWindow: T0 });
    expect(await processNext(s, CFG, run({ now: T0 + 400, finalizedBlockTime: T0 + 329 }))).toEqual({ kind: "NOT_DUE", nextWindow: T0 });
    // Worker woke late (drift: 3 windows behind) → catches up strictly in order, one per call.
    const late = run({ now: T0 + 1300, finalizedBlockTime: T0 + 1300 });
    const ws = []; for (let i = 0; i < 3; i++) { const r = await processNext(s, CFG, late); if (r.kind === "SEALED") ws.push(r.plan.window); }
    expect(ws).toEqual([T0, T0 + 300, T0 + 600]);
  });
  it("RPC outage → CHAIN_TIME_UNKNOWN, nothing sealed", async () => {
    const s = memoryStore();
    expect((await processNext(s, CFG, run({ finalizedBlockTime: null }))).kind).toBe("CHAIN_TIME_UNKNOWN");
    expect(await s.watermark()).toBeNull();
  });
  it("missing holder index / stale or unapproved policy / ambiguous custody → HELD", async () => {
    for (const snapshot of [async () => null, async () => snapOf([["a", 1n]], { ...policy, approved: false })]) {
      const s = memoryStore(); await ingestDistribution(s, CFG, dist({ r: 6000n, op: 4000n }), true);
      const r = await processNext(s, CFG, run({ snapshot })); if (r.kind !== "SEALED") throw new Error();
      expect(r.plan.status).toBe("HELD");
      expect(r.plan.holdReasons.some((x) => x === "HOLDER_INDEX_UNAVAILABLE" || x === "SNAPSHOT:exclusion_config_not_approved")).toBe(true);
    }
  });
  it("cost reserve shortage or unknown → HOLD; costs never deducted from holder budgets", async () => {
    const s = memoryStore(); await ingestDistribution(s, CFG, dist({ r: 6000n, op: 4000n }), true);
    const r = await processNext(s, CFG, run({ costs: () => ({ estimateLamports: 5000n, reserveLamports: 10n }) })); if (r.kind !== "SEALED") throw new Error();
    expect(r.plan.holdReasons).toContain("COST_RESERVE_INSUFFICIENT"); expect(r.plan.solBudget).toBe(3000n);
    const s2 = memoryStore(); await ingestDistribution(s2, CFG, dist({ r: 6000n, op: 4000n }), true);
    const r2 = await processNext(s2, CFG, run({ costs: () => ({ estimateLamports: null, reserveLamports: null }) }));
    expect(r2.kind === "SEALED" && r2.plan.holdReasons).toContain("COST_RESERVE_UNKNOWN");
  });
  it("late receipt never rewrites a sealed window; becomes an auditable adjustment of the next", async () => {
    const s = memoryStore();
    await ingestDistribution(s, CFG, dist({ r: 600n, op: 400n, n: 1 }), true);
    const first = await processNext(s, CFG, run()); if (first.kind !== "SEALED") throw new Error();
    const frozen = JSON.stringify(first.plan, (_, v) => (typeof v === "bigint" ? String(v) : v));
    expect(await ingestDistribution(s, CFG, dist({ r: 1200n, op: 800n, n: 2 }), true)).toEqual({ kind: "LATE_ADJUSTMENT" });
    const second = await processNext(s, CFG, run({ now: T0 + 700, finalizedBlockTime: T0 + 700 })); if (second.kind !== "SEALED") throw new Error();
    expect(second.plan.adjustmentKeys).toHaveLength(1); expect(second.plan.rewardsTotal).toBe(1200n);
    expect(JSON.stringify(await s.sealedPlan(T0), (_, v) => (typeof v === "bigint" ? String(v) : v))).toBe(frozen);
    expect(Object.isFrozen(await s.sealedPlan(T0))).toBe(true);
  });
  it("two workers racing: lease admits one; stale watermark commit refused", async () => {
    const s = memoryStore(); await ingestDistribution(s, CFG, dist({ r: 600n, op: 400n }), true);
    expect(await s.acquireLease("w2", T0 + 400, T0 + 460)).toBe(true);
    expect((await processNext(s, CFG, run())).kind).toBe("LEASE_HELD");
    await s.releaseLease("w2");
    const sealed = await processNext(s, CFG, run()); if (sealed.kind !== "SEALED") throw new Error();
    expect(await s.commitWindow(null, sealed.plan, new Map())).toBe(false);
  });
  it("crash at every boundary then replay → identical monetary outcome and plan id", async () => {
    const mk = async () => { const s = memoryStore(); await ingestDistribution(s, CFG, dist({ r: 600_001n, op: 400_000n }), true); return s; };
    const ref = await processNext(await mk(), CFG, run()); if (ref.kind !== "SEALED") throw new Error();
    for (const crashAt of ["after_lease", "before_commit"] as const) {
      const s = await mk();
      await expect(processNext(s, CFG, run({ crashAt }))).rejects.toThrow();
      expect(await s.watermark()).toBeNull(); // nothing partial persisted; lease released
      const again = await processNext(s, CFG, run()); if (again.kind !== "SEALED") throw new Error();
      expect(again.plan.planId).toBe(ref.plan.planId);
      expect(again.plan.solEntitlements).toEqual(ref.plan.solEntitlements);
    }
  });
  it("out-of-order arrivals inside a window give the same plan", async () => {
    const a = dist({ r: 600n, op: 400n, n: 1 }), b = dist({ r: 1201n, op: 800n, n: 2 });
    const p = async (xs: Distribution[]) => { const s = memoryStore(); for (const x of xs) await ingestDistribution(s, CFG, x, true); const r = await processNext(s, CFG, run()); if (r.kind !== "SEALED") throw new Error(); return r.plan; };
    const [x, y] = [await p([a, b]), await p([b, a])];
    expect(x.planId).toBe(y.planId); expect(x.buybackBudget).toBe(y.buybackBudget);
  });
});

describe("05-D buyback fills and reconciliation", () => {
  const base = async () => { const s = memoryStore(); await ingestDistribution(s, CFG, dist({ r: 6000n, op: 4000n }), true); const r = await processNext(s, CFG, run()); if (r.kind !== "SEALED") throw new Error(); return { s, p: r.plan }; };
  it("pending/failed buyback yields no token entitlements; over-budget fill blocked", async () => {
    const { p } = await base();
    expect(allocateFill(p, null, [{ owner: "a", amount: 1n }]).kind).toBe("PENDING_FILL");
    expect(allocateFill(p, { verified: false, spentLamports: 1n, tokenOut: 10n }, []).kind).toBe("PENDING_FILL");
    expect(allocateFill(p, { verified: true, spentLamports: 3001n, tokenOut: 10n }, []).kind).toBe("BLOCKED");
  });
  it("UNKNOWN ≠ NOT_FOUND ≠ zero; shortfall fails closed; exact match reconciles", async () => {
    const { s } = await base();
    expect(await reconcile(s, T0 + 9999, { kind: "VALUE", lamports: 0n }, { kind: "VALUE", lamports: 0n })).toEqual({ kind: "NOT_FOUND" });
    expect((await reconcile(s, T0, { kind: "UNKNOWN", reason: "rpc" }, { kind: "VALUE", lamports: 4000n })).kind).toBe("MISMATCH");
    expect(await reconcile(s, T0, { kind: "VALUE", lamports: 5999n }, { kind: "NOT_FOUND" })).toEqual({ kind: "MISMATCH", issues: ["rewards_shortfall", "operations_not_found"] });
    expect(await reconcile(s, T0, { kind: "VALUE", lamports: 6000n }, { kind: "VALUE", lamports: 4000n })).toEqual({ kind: "RECONCILED" });
  });
});
