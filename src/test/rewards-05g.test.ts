import { describe, expect, it } from "vitest";
import { initIndex, applyTx, recordCoverage, repairGap, snapshotAt, type IndexedTx } from "@/lib/rewards/holder-index";
import { decodeFeeEvents } from "@/lib/rewards/pump-events";
import { ingestCreatorFee } from "@/lib/rewards/native-single";
import { processNext, memoryStore, allocateFill, type NativeConfig } from "@/lib/rewards/processor";
import { buildEligibility } from "@/lib/rewards/eligibility";
import { EPOCH_SECONDS } from "@/lib/rewards/epochs";
import t5MKt from "./fixtures/pump/5MKtaAm1.json";

const M = "FixtureMint";
const bal = (account: string, owner: string, amount: bigint) => ({ account, owner, mint: M, amount });
const tx = (sig: string, slot: number, pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], o: Partial<IndexedTx> = {}): IndexedTx =>
  ({ signature: sig, slot, blockTime: slot, finalized: true, failed: false, pre, post, ...o });
const anchor = () => initIndex(M, { slot: 100, verified: true, accounts: [bal("a1", "alice", 70n), bal("b1", "bob", 30n)] });

describe("holder index (fixture data)", () => {
  it("applies transfers, ATA creation and closure; snapshot reconciles supply", () => {
    const s = anchor();
    expect(applyTx(s, tx("t1", 101, [bal("a1", "alice", 70n)], [bal("a1", "alice", 50n), bal("c1", "carol", 20n)]))).toBe("APPLIED");
    expect(applyTx(s, tx("t2", 102, [bal("b1", "bob", 30n), bal("a1", "alice", 50n)], [bal("a1", "alice", 80n)]))).toBe("APPLIED"); // b1 closed
    recordCoverage(s, { fromSlot: 101, toSlot: 110, complete: true, source: "fixture" });
    const snap = snapshotAt(s, 105, 100n);
    expect(snap).toEqual({ kind: "SNAPSHOT", slot: 105, owners: [{ owner: "alice", amount: 80n }, { owner: "carol", amount: 20n }], ownerless: 0n, total: 100n });
  });
  it("replay of the same tx is a no-op (sum unchanged)", () => {
    const s = anchor(); const t = tx("t1", 101, [bal("a1", "alice", 70n)], [bal("a1", "alice", 60n), bal("c1", "carol", 10n)]);
    applyTx(s, t); expect(applyTx(s, t)).toBe("DUPLICATE");
    recordCoverage(s, { fromSlot: 101, toSlot: 101, complete: true, source: "fixture" });
    expect(snapshotAt(s, 101, 100n).kind).toBe("SNAPSHOT");
  });
  it("missed history → pre-balance mismatch stops ingestion (never guesses)", () => {
    expect(applyTx(anchor(), tx("t9", 105, [bal("a1", "alice", 69n)], [bal("a1", "alice", 0n)]))).toEqual({ error: "PRE_BALANCE_MISMATCH:a1" });
  });
  it("unfinalized and pre-anchor txs refused; failed txs change nothing", () => {
    const s = anchor();
    expect(applyTx(s, tx("u", 101, [], [], { finalized: false }))).toEqual({ error: "NOT_FINALIZED" });
    expect(applyTx(s, tx("p", 99, [], []))).toEqual({ error: "BEFORE_ANCHOR" });
    expect(applyTx(s, tx("f", 101, [bal("a1", "alice", 70n)], [bal("a1", "alice", 0n)], { failed: true }))).toBe("SKIPPED_FAILED");
    expect(s.balances.get("a1")!.amount).toBe(70n);
  });
  it("gaps block snapshots until a complete replay repairs them; supply mismatch blocks", () => {
    const s = anchor();
    recordCoverage(s, { fromSlot: 101, toSlot: 120, complete: false, source: "public-rpc" });
    expect(snapshotAt(s, 110, 100n)).toEqual({ kind: "BLOCKED", reason: "GAP_BEFORE_SLOT" });
    expect(repairGap(s, { fromSlot: 101, toSlot: 120 }, { fromSlot: 105, toSlot: 120, complete: true, source: "x" })).toBe(false);
    expect(repairGap(s, { fromSlot: 101, toSlot: 120 }, { fromSlot: 101, toSlot: 120, complete: true, source: "x" })).toBe(true);
    expect(snapshotAt(s, 110, 100n).kind).toBe("SNAPSHOT");
    expect(snapshotAt(s, 110, 101n)).toEqual({ kind: "BLOCKED", reason: "SUPPLY_MISMATCH" });
    expect(snapshotAt(s, 999, 100n)).toEqual({ kind: "BLOCKED", reason: "NOT_COVERED_YET" });
  });
  it("unverified anchor is refused", () => {
    expect(() => initIndex(M, { slot: 1, verified: false, accounts: [] })).toThrow("ANCHOR_NOT_VERIFIED");
  });
});

describe("E2E dry run (real fee event + fixture holders + fixture fill)", () => {
  it("fee → 30/30/40 → snapshot → SOL entitlements → verified fill → token entitlements, all conserved", async () => {
    const d = decodeFeeEvents(t5MKt as never); if (d.kind !== "OK") throw new Error();
    const ev = d.events[0]!; const deployer = ev.recipient;
    const cfg: NativeConfig = { feeModel: "SINGLE_DEPLOYER", deployerWallet: deployer, mint: M, sharingConfig: null, rewardsTreasury: null, operationsTreasury: null, finalityLagSeconds: 60, minPayableLamports: 1n };
    const store = memoryStore();
    expect((await ingestCreatorFee(store, { mint: M, deployerWallet: deployer, childFeeWallets: [] }, ev, true, { createdMints: [M] })).kind).toBe("CREDITED");
    const s = anchor(); recordCoverage(s, { fromSlot: 101, toSlot: 200, complete: true, source: "fixture" });
    const hs = snapshotAt(s, 150, 100n); if (hs.kind !== "SNAPSHOT") throw new Error();
    const policy = { version: "fixture-v1", approved: true, poolVaults: [], treasuries: [], reserves: [], resolvedOwners: {} };
    const w = Math.floor(ev.blockTime! / EPOCH_SECONDS) * EPOCH_SECONDS;
    const r = await processNext(store, cfg, { workerId: "w", now: w + 1000, leaseSeconds: 60, finalizedBlockTime: w + 1000, genesisWindow: w,
      snapshot: async () => buildEligibility({ mint: M, slot: 150, commitment: "finalized", totalSupply: 100n, source: "fixture",
        accounts: hs.owners.map((o, i) => ({ account: `acc${i}`, mint: M, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", owner: o.owner, amount: o.amount, slot: 150, ownerKind: "WALLET" as const })) }, policy),
      costs: () => ({ estimateLamports: 10_000n, reserveLamports: 9_979_260n }) });
    if (r.kind !== "SEALED") throw new Error(r.kind);
    const p = r.plan;
    expect(p.solBudget + p.buybackBudget + p.operationsTotal).toBe(24_948_150n);
    const paid = p.solEntitlements.reduce((a, x) => a + x.lamports, 0n) + p.solCarriedOut.reduce((a, x) => a + x.lamports, 0n) + p.solDust;
    expect(paid).toBe(p.solBudget);
    expect(p.mode).toBe("DRY_RUN");
    expect(allocateFill(p, null, hs.owners)).toEqual({ kind: "PENDING_FILL" }); // no tokens before a verified fill
    const f = allocateFill(p, { verified: true, spentLamports: p.buybackBudget, tokenOut: 1_000_003n }, hs.owners);
    if (f.kind !== "DRY_RUN") throw new Error();
    expect(f.entitlements.reduce((a, x) => a + x.lamports, 0n) + f.dust).toBe(1_000_003n);
    expect(allocateFill(p, { verified: true, spentLamports: p.buybackBudget + 1n, tokenOut: 1n }, hs.owners)).toMatchObject({ kind: "BLOCKED" });
  });
});
