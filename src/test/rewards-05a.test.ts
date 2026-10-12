import { describe, expect, it } from "vitest";
import { allocate, proRata, U64_MAX } from "@/lib/rewards/economics";
import { canClose, canTransition, epochStart } from "@/lib/rewards/epochs";
import { ingest, memoryStore, transition, type Expected, type ObservedFeeEvent } from "@/lib/rewards/ledger";
import { buildSnapshot, entitlements } from "@/lib/rewards/snapshot";
import { rewardsReadiness } from "@/lib/rewards/readiness";

const SIG = "5".repeat(87);
const exp: Expected = { programs: { PUMP_CURVE_COLLECT_V2: "PUMP", PUMP_AMM_COLLECT_COIN_CREATOR: "AMM", PUMP_FEES_DISTRIBUTE_V2: "PUMP" }, mint: "MCP", recipient: "RECV", asset: "SOL" };
const ev = (o: Partial<ObservedFeeEvent> = {}): ObservedFeeEvent => ({ signature: SIG, ixIndex: 0, eventIndex: 0, source: "PUMP_CURVE_COLLECT_V2", programId: "PUMP", mint: "MCP", recipient: "RECV", asset: "SOL", amount: 1_000_000n, slot: 1, blockTime: 1_800_000_000, commitment: "finalized", ...o });

describe("30/30/40 split", () => {
  it("splits exactly in integers", () => {
    expect(allocate(10_000n, 0n)).toMatchObject({ holderSol: 3000n, buyback: 3000n, operations: 4000n, residualOut: 0n });
  });
  it("tiny amounts carry residual and conserve", () => {
    const a = allocate(1n, 0n);
    expect(a.holderSol + a.buyback + a.operations + a.residualOut).toBe(1n);
    expect(a.residualOut).toBe(1n);
  });
  it("u64 max conserves", () => {
    const a = allocate(U64_MAX, 9999n);
    expect(a.holderSol + a.buyback + a.operations + a.residualOut).toBe(U64_MAX + 9999n);
  });
  it("chained receipts conserve: sum(allocations)+residual = sum(receipts)", () => {
    let carry = 0n, alloc = 0n, rec = 0n;
    for (const n of [1n, 7n, 3n, 123_456_789n, 9_999n, 1n, 2n]) { const a = allocate(n, carry); rec += n; alloc += a.holderSol + a.buyback + a.operations; carry = a.residualOut; }
    expect(alloc + carry).toBe(rec);
    expect(carry < 10_000n).toBe(true);
  });
  it("rejects zero and out-of-range", () => {
    expect(() => allocate(0n, 0n)).toThrow();
    expect(() => allocate(U64_MAX + 1n, 0n)).toThrow();
  });
});

describe("fee ingest", () => {
  it("credits once; replay of same signature+indexes is a duplicate", async () => {
    const s = memoryStore();
    expect((await ingest(s, ev(), exp)).kind).toBe("CREDITED");
    expect((await ingest(s, ev(), exp)).kind).toBe("DUPLICATE");
  });
  it("same signature, different event index is a separate receipt", async () => {
    const s = memoryStore();
    await ingest(s, ev(), exp);
    expect((await ingest(s, ev({ eventIndex: 1 }), exp)).kind).toBe("CREDITED");
    expect(s.events.size).toBe(2);
  });
  it("non-finalized is pending, not credited and not stored", async () => {
    const s = memoryStore();
    expect((await ingest(s, ev({ commitment: "confirmed" }), exp)).kind).toBe("PENDING_FINALITY");
    expect(s.events.size).toBe(0);
  });
  it("quarantines unexpected program, mint, recipient and fee asset", async () => {
    const s = memoryStore();
    for (const [o, r] of [[{ programId: "X" }, "unexpected_program"], [{ mint: "X", eventIndex: 1 }, "unexpected_mint"], [{ recipient: "X", eventIndex: 2 }, "unexpected_recipient"], [{ asset: "USDC", eventIndex: 3 }, "unexpected_fee_asset"]] as const)
      expect(await ingest(s, ev(o), exp)).toEqual({ kind: "QUARANTINED", reason: r });
    expect(await s.carry()).toBe(0n);
  });
  it("crash before commit leaves nothing; retry credits exactly once", async () => {
    const s = memoryStore(); s.failNextCommit = true;
    await expect(ingest(s, ev(), exp)).rejects.toThrow("crash_before_commit");
    expect(s.events.size).toBe(0);
    expect((await ingest(s, ev(), exp)).kind).toBe("CREDITED");
    expect((await ingest(s, ev(), exp)).kind).toBe("DUPLICATE");
  });
  it("overlapping workers: commit race yields one credit", async () => {
    const s = memoryStore();
    const r = await Promise.all([ingest(s, ev(), exp), ingest(s, ev(), exp)]);
    expect(r.filter((x) => x.kind === "CREDITED")).toHaveLength(1);
  });
});

describe("epochs", () => {
  it("aligns to 5-minute UTC windows; boundary belongs to the new epoch", () => {
    expect(epochStart(1_800_000_299)).toBe(1_799_999_700 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 0 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300 - 300 + 300);
    expect(epochStart(1_800_000_100) % 300).toBe(0);
    expect(epochStart(1_800_000_300)).toBe(1_800_000_300);
    expect(epochStart(1_800_000_299)).toBe(1_800_000_000);
  });
  it("cannot close without finalized chain time past the end", () => {
    expect(canClose(1_800_000_000, 1_800_000_400, null)).toBe(false);
    expect(canClose(1_800_000_000, 1_800_000_400, 1_800_000_299)).toBe(false);
    expect(canClose(1_800_000_000, 1_800_000_400, 1_800_000_300)).toBe(true);
  });
  it("no-fee epoch carries forward; settled is final", () => {
    expect(canTransition("OPEN", "CARRIED_FORWARD")).toBe(true);
    expect(() => transition("SETTLED", "FUNDED")).toThrow();
    expect(() => transition("OPEN", "SETTLED")).toThrow();
  });
});

describe("snapshot", () => {
  const policy = { excludedOwners: new Set(["LP_VAULT"]), excludePdaOwners: true, minBalance: 1n, approved: false };
  it("merges multiple token accounts of one owner and excludes custody", () => {
    const s = buildSnapshot([
      { account: "a1", owner: "W1", amount: 5n, slot: 9 }, { account: "a2", owner: "W1", amount: 5n, slot: 9 },
      { account: "a3", owner: "W2", amount: 10n, slot: 9 }, { account: "a4", owner: "LP_VAULT", amount: 1000n, slot: 9 },
      { account: "a5", owner: "PDA", amount: 50n, slot: 9, ownerIsPda: true }, { account: "a6", owner: "W3", amount: 0n, slot: 9 },
    ], policy);
    expect(s).toMatchObject({ kind: "OK", holders: [{ owner: "W1", amount: 10n }, { owner: "W2", amount: 10n }], excludedAmount: 1050n });
  });
  it("mixed slots and empty reads are inconsistent, not zero holders", () => {
    expect(buildSnapshot([{ account: "a", owner: "W", amount: 1n, slot: 1 }, { account: "b", owner: "V", amount: 1n, slot: 2 }], policy).kind).toBe("INCONSISTENT");
    expect(buildSnapshot([], policy).kind).toBe("INCONSISTENT");
  });
  it("entitlements are BLOCKED until the eligibility policy is approved; dry run conserves with dust", () => {
    const s = buildSnapshot([{ account: "a", owner: "A", amount: 1n, slot: 1 }, { account: "b", owner: "B", amount: 1n, slot: 1 }, { account: "c", owner: "C", amount: 1n, slot: 1 }], policy);
    expect(entitlements(s, 100n, { dryRun: false })).toEqual({ kind: "BLOCKED", reason: "eligibility_policy_not_approved" });
    const r = entitlements(s, 100n, { dryRun: true });
    if (r.kind !== "OK") throw new Error();
    expect([...r.shares.values()].reduce((a, b) => a + b, 0n) + r.dust).toBe(100n);
  });
  it("amounts below the payable unit become dust", () => {
    const { shares, dust } = proRata(2n, [{ owner: "A", amount: 1n }, { owner: "B", amount: 1n }, { owner: "C", amount: 1n }], 2n);
    expect(shares.size).toBe(0);
    expect(dust).toBe(2n);
  });
});

describe("readiness", () => {
  it("with no mint is BLOCKED_NO_NATIVE_MINT and never enabled", () => {
    const r = rewardsReadiness({ nativeMint: null, feeReceiver: null, rewardsTreasury: null, operationsTreasury: null, swapSigner: false, payoutSigner: false, policyApproved: false, collectionProven: false, quoteMintProven: false });
    expect(r.blockers[0]).toBe("BLOCKED_NO_NATIVE_MINT");
    expect(r.distributionsEnabled).toBe(false);
    expect(r.blockers).toContain("EXECUTION_NOT_APPROVED");
  });
});
