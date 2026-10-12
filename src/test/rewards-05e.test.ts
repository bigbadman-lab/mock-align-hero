// 05-E pure tests: holder history reconstruction, reason classes, bounded catch-up, replay alarm. Fixture labels only.
import { describe, expect, it } from "vitest";
import { reconstructAt, unavailableHistory, type Anchor, type Change } from "@/lib/rewards/holder-history";
import { buildEligibility } from "@/lib/rewards/eligibility";
import { classify, ingestDistribution, memoryStore, processNext, runPass, type NativeConfig, type ProcessInput } from "@/lib/rewards/processor";
import { EPOCH_SECONDS } from "@/lib/rewards/epochs";

const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const anchor: Anchor = { mint: "FX_MINT", slot: 1000, supply: 100n, source: "fixture-anchor", accounts: [
  { account: "a1", mint: "FX_MINT", tokenProgram: SPL, owner: "alice", ownerKind: "WALLET", amount: 60n },
  { account: "a2", mint: "FX_MINT", tokenProgram: T22, owner: "alice", ownerKind: "WALLET", amount: 10n },
  { account: "pool", mint: "FX_MINT", tokenProgram: SPL, owner: "POOL_PDA", ownerKind: "PROGRAM", amount: 30n },
] };
const ch: Change[] = [
  { seq: 1, slot: 1001, kind: "CREATE", account: "b1", owner: "bob", tokenProgram: SPL, ownerKind: "WALLET" },
  { seq: 2, slot: 1001, kind: "BALANCE", account: "a1", amount: 50n },
  { seq: 3, slot: 1001, kind: "BALANCE", account: "b1", amount: 10n },
  { seq: 4, slot: 1005, kind: "OWNER", account: "a2", owner: "carol", ownerKind: "WALLET" },
  { seq: 5, slot: 1007, kind: "DELEGATE", account: "b1", delegated: true },
  { seq: 6, slot: 1009, kind: "BALANCE", account: "a2", amount: 0n },
  { seq: 7, slot: 1009, kind: "BALANCE", account: "a1", amount: 60n },
  { seq: 8, slot: 1010, kind: "CLOSE", account: "a2" },
];
const cov = { fromSlot: 1001, toSlot: 1010, lastSeq: 8 };

describe("05-E holder history", () => {
  it("reconstructs past slots from anchor + contiguous changes; owner reassignment and close respected", () => {
    const at1004 = reconstructAt(anchor, ch, cov, 1004); if (at1004.kind !== "OK") throw new Error(at1004.reason);
    const e = buildEligibility(at1004.input, { version: "fx", approved: true, poolVaults: ["POOL_PDA"], treasuries: [], reserves: [], resolvedOwners: {} });
    expect(e.holders).toEqual([{ owner: "alice", amount: 60n }, { owner: "bob", amount: 10n }]); // SPL+T22 aggregated
    expect(e.status).toBe("COMPLETE");
    const at1010 = reconstructAt(anchor, ch, cov, 1010); if (at1010.kind !== "OK") throw new Error();
    expect(at1010.input.accounts.map((a) => a.account).sort()).toEqual(["a1", "b1", "pool"]);
    const e2 = buildEligibility(at1010.input, { version: "fx", approved: true, poolVaults: ["POOL_PDA"], treasuries: [], reserves: [], resolvedOwners: {} });
    expect(e2.ambiguous).toEqual([{ owner: "bob", amount: 10n, why: "delegated" }]); // delegated → review, not silently counted
    expect(e2.livePayoutAllowed).toBe(false);
  });
  it("program-owned holdings are not blanket-excluded: unlisted program owner is ambiguous", () => {
    const r = reconstructAt(anchor, [], null, 1000); if (r.kind !== "OK") throw new Error();
    const e = buildEligibility(r.input, { version: "fx", approved: true, poolVaults: [], treasuries: [], reserves: [], resolvedOwners: {} });
    expect(e.ambiguous.map((x) => x.owner)).toEqual(["POOL_PDA"]);
  });
  it("blocks on gaps, sequence holes, pre-anchor slots, supply mismatch and no source", async () => {
    expect(reconstructAt(null, [], null, 5)).toEqual({ kind: "BLOCKED", reason: "no_anchor_snapshot" });
    expect(reconstructAt(anchor, ch, cov, 999).kind).toBe("BLOCKED");
    expect(reconstructAt(anchor, ch, { ...cov, toSlot: 1006 }, 1009)).toEqual({ kind: "BLOCKED", reason: "coverage_gap_before_target_slot" });
    expect(reconstructAt(anchor, ch.filter((c) => c.seq !== 4), { ...cov }, 1010)).toEqual({ kind: "BLOCKED", reason: "change_sequence_gap" });
    expect(reconstructAt(anchor, [{ seq: 1, slot: 1002, kind: "BALANCE", account: "a1", amount: 61n }], { fromSlot: 1001, toSlot: 1003, lastSeq: 1 }, 1003))
      .toEqual({ kind: "BLOCKED", reason: "reconstructed_balances_do_not_reconcile_to_supply" });
    expect(reconstructAt(anchor, [{ seq: 1, slot: 1002, kind: "CLOSE", account: "a1" }], { fromSlot: 1001, toSlot: 1003, lastSeq: 1 }, 1003).kind).toBe("BLOCKED");
    expect(await unavailableHistory.snapshotAt(1)).toEqual({ kind: "BLOCKED", reason: "historical_holder_source_not_configured" });
  });
});

const CFG: NativeConfig = { mint: "FIXTURE_MINT", sharingConfig: "FIXTURE_SHARING", rewardsTreasury: "FIXTURE_REWARDS", operationsTreasury: "FIXTURE_OPS", finalityLagSeconds: 30, minPayableLamports: 1n };
const T0 = 1_800_000_000 - (1_800_000_000 % EPOCH_SECONDS);
const inp = (o: Partial<ProcessInput> = {}): ProcessInput => ({ workerId: "w", now: T0 + 5000, leaseSeconds: 30, finalizedBlockTime: T0 + 5000, genesisWindow: T0, snapshot: async () => null, costs: () => ({ estimateLamports: null, reserveLamports: null }), ...o });

describe("05-E processor additions", () => {
  it("bounded catch-up seals at most N windows per pass and refuses unbounded loops", async () => {
    const s = memoryStore();
    expect((await runPass(s, CFG, inp(), 3)).map((r) => r.kind)).toEqual(["SEALED", "SEALED", "SEALED"]);
    expect(await s.watermark()).toBe(T0 + 600);
    await expect(runPass(s, CFG, inp(), 10_000)).rejects.toThrow("max_windows_out_of_range");
  });
  it("distinct reason classes", async () => {
    const s = memoryStore();
    expect(classify(await processNext(s, CFG, inp({ finalizedBlockTime: null })))).toEqual(["RPC_UNKNOWN"]);
    expect(classify(await processNext(s, CFG, inp({ now: T0 + 1, finalizedBlockTime: T0 + 1 })))).toEqual(["REORG_OR_FINALITY_UNCERTAIN"]);
    expect(classify(await processNext(s, CFG, inp()))).toEqual(["NO_VERIFIED_RECEIPTS", "EXECUTION_NOT_APPROVED"]);
    const sig = "5".repeat(88);
    await ingestDistribution(s, CFG, { signature: sig, slot: 1, blockTime: T0 + 310, ixIndex: 0, eventIndex: 0, mint: "FIXTURE_MINT", bondingCurve: "b", sharingConfig: "FIXTURE_SHARING", creatorVault: "v", admin: "a", quoteMint: "q", distributed: 10n, asset: "SOL",
      receipts: [{ address: "FIXTURE_REWARDS", shareBps: 6000, lamports: 6n }, { address: "FIXTURE_OPS", shareBps: 4000, lamports: 4n }] }, true);
    expect(classify(await processNext(s, CFG, inp())).sort()).toEqual(["COST_RESERVE_UNAVAILABLE", "EXECUTION_NOT_APPROVED", "SNAPSHOT_INCOMPLETE"]);
    expect(classify(await processNext(memoryStore(), { ...CFG, rewardsTreasury: null }, inp()))).toContain("TREASURY_NOT_CONFIGURED");
  });
  it("replay that recomputes a different digest for a sealed window raises RECONCILIATION_ALARM", async () => {
    const s = memoryStore();
    const first = await processNext(s, CFG, inp()); if (first.kind !== "SEALED") throw new Error();
    const tampered = { ...s, watermark: async () => null, consumed: async () => new Set<string>(), sealedPlan: async () => ({ ...first.plan, inputDigest: "f".repeat(64) }) };
    const r = await processNext(tampered, CFG, inp());
    expect(r.kind).toBe("RECONCILIATION_ALARM");
    expect(classify(r)).toEqual(["LEDGER_IMBALANCE"]);
  });
});
