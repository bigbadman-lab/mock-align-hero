import { describe, expect, it } from "vitest";
import { decodeFeeEvents, WSOL_MINT, type FeeEvidence } from "@/lib/rewards/pump-events";
import { split303040, attributeCreatorFee, ingestCreatorFee, checkSpendable, signerSecretShape, signerStartupGate, type SingleWalletConfig } from "@/lib/rewards/native-single";
import { processNext, memoryStore, ingestDistribution, configBlockers, type NativeConfig } from "@/lib/rewards/processor";
import { canReplace } from "@/lib/rewards/payout";
import { EPOCH_SECONDS } from "@/lib/rewards/epochs";
import t5MKt from "./fixtures/pump/5MKtaAm1.json";

const DEPLOYER = "6Vf3QXGdPm7os7p3UisqxVUVgSZswVK1wUDuVNikNK2x"; // recipient in the real finalized fixture
const MINT = "FixtureMint1111111111111111111111111111111";
const CFG: SingleWalletConfig = { mint: MINT, deployerWallet: DEPLOYER, childFeeWallets: ["ChildA", "ChildB"] };
const ONLY = { createdMints: [MINT] };
const real = () => { const d = decodeFeeEvents(t5MKt as never); if (d.kind !== "OK") throw new Error(); return d.events[0]!; };
const PCFG: NativeConfig = { feeModel: "SINGLE_DEPLOYER", deployerWallet: DEPLOYER, mint: MINT, sharingConfig: null, rewardsTreasury: null, operationsTreasury: null, finalityLagSeconds: 60, minPayableLamports: 1n };

describe("30/30/40 split", () => {
  it("real fixture 24,948,150 → 7,484,445 / 7,484,445 / 9,979,260", () => {
    expect(split303040(24_948_150n)).toEqual({ solBudget: 7_484_445n, buybackBudget: 7_484_445n, operations: 9_979_260n });
  });
  it("rounding remainder goes to operations; sum always exact", () => {
    for (const a of [1n, 3n, 7n, 9_999n, 10_001n, 123_456_789n]) { const s = split303040(a); expect(s.solBudget + s.buybackBudget + s.operations).toBe(a); expect(s.solBudget).toBe((a * 3000n) / 10000n); }
    expect(split303040(1n)).toEqual({ solBudget: 0n, buybackBudget: 0n, operations: 1n });
  });
});

describe("single-recipient creator-fee attribution", () => {
  it("real finalized curve collection to the deployer is attributed", () => {
    const a = attributeCreatorFee(CFG, real(), true, ONLY);
    expect(a.kind).toBe("ATTRIBUTED");
    if (a.kind === "ATTRIBUTED") expect(a.receipt.rewardsLamports + a.receipt.operationsLamports).toBe(24_948_150n);
  });
  it("blocks: not finalized, other recipient, unknown provenance, other coins, deployer = child wallet", () => {
    expect(attributeCreatorFee(CFG, real(), false, ONLY)).toEqual({ kind: "BLOCKED", reason: "not_finalized" });
    expect(attributeCreatorFee({ ...CFG, deployerWallet: "Other" }, real(), true, { createdMints: [MINT] })).toEqual({ kind: "BLOCKED", reason: "recipient_not_deployer" });
    expect(attributeCreatorFee(CFG, real(), true, { createdMints: null })).toEqual({ kind: "BLOCKED", reason: "PROVENANCE_UNKNOWN" });
    expect(attributeCreatorFee(CFG, real(), true, { createdMints: [MINT, "Another"] })).toEqual({ kind: "BLOCKED", reason: "DEPLOYER_CREATED_OTHER_COINS" });
    expect(attributeCreatorFee({ ...CFG, childFeeWallets: [DEPLOYER] }, real(), true, ONLY)).toEqual({ kind: "BLOCKED", reason: "DEPLOYER_IS_CHILD_FEE_WALLET" });
    expect(attributeCreatorFee({ ...CFG, mint: null }, real(), true, ONLY)).toEqual({ kind: "BLOCKED", reason: "NATIVE_MINT_UNSET" });
  });
  it("PumpSwap WSOL accepted only with a verified deployer WSOL destination", () => {
    const amm: FeeEvidence = { ...real(), source: "PUMP_AMM_COLLECT_COIN_CREATOR", asset: "WSOL", extra: { destinationTokenAccount: "Ata1" } };
    expect(attributeCreatorFee(CFG, amm, true, ONLY)).toEqual({ kind: "BLOCKED", reason: "wsol_destination_not_verified" });
    const ok = { ...amm, extra: { ...amm.extra, verifiedDestinationOwner: DEPLOYER, verifiedDestinationMint: WSOL_MINT } };
    expect(attributeCreatorFee(CFG, ok, true, ONLY).kind).toBe("ATTRIBUTED");
  });
  it("non-SOL quote coins are refused", () => {
    expect(attributeCreatorFee(CFG, { ...real(), asset: "UsdcMint" }, true, ONLY)).toEqual({ kind: "BLOCKED", reason: "non_sol_quote" });
  });
});

describe("durable ingest + window planning without fee sharing", () => {
  it("dedupes replays and plans a held window from the single receipt", async () => {
    const s = memoryStore();
    expect(await ingestCreatorFee(s, CFG, real(), true, ONLY)).toEqual({ kind: "CREDITED" });
    expect(await ingestCreatorFee(s, CFG, real(), true, ONLY)).toEqual({ kind: "DUPLICATE" });
    const ev = real(); const w = Math.floor(ev.blockTime! / EPOCH_SECONDS) * EPOCH_SECONDS;
    const r = await processNext(s, PCFG, { workerId: "w", now: w + 1000, leaseSeconds: 60, finalizedBlockTime: w + 1000, genesisWindow: w,
      snapshot: async () => null, costs: () => ({ estimateLamports: null, reserveLamports: null }) });
    if (r.kind !== "SEALED") throw new Error(r.kind);
    expect(r.plan.solBudget).toBe(7_484_445n); expect(r.plan.buybackBudget).toBe(7_484_445n); expect(r.plan.operationsTotal).toBe(9_979_260n);
    expect(r.plan.status).toBe("HELD"); expect(r.plan.holdReasons).toContain("HOLDER_INDEX_UNAVAILABLE"); expect(r.plan.solEntitlements).toEqual([]);
    expect(r.plan.holdReasons.some((h) => /SHARING|TREASURY/.test(h))).toBe(false);
  });
  it("zero-fee window seals as empty; native model never needs sharing config or treasuries", async () => {
    expect(configBlockers(PCFG)).toEqual([]);
    expect(configBlockers({ ...PCFG, deployerWallet: null })).toEqual(["DEPLOYER_WALLET_UNSET"]);
    const r = await processNext(memoryStore(), PCFG, { workerId: "w", now: 10_000, leaseSeconds: 60, finalizedBlockTime: 10_000, genesisWindow: 0,
      snapshot: async () => null, costs: () => ({ estimateLamports: null, reserveLamports: null }) });
    if (r.kind !== "SEALED") throw new Error(); expect(r.plan.receiptKeys).toEqual([]); expect(r.plan.solBudget).toBe(0n);
  });
  it("legacy 60/40 sharing distributions cannot credit the native model", async () => {
    expect(await ingestDistribution(memoryStore(), PCFG, {} as never, true)).toEqual({ kind: "REJECTED", reason: "fee_sharing_not_used_by_native_model" });
  });
});

describe("single-wallet spend guard", () => {
  const base = { finalizedBalance: 100_000_000n, rentExemptMin: 890_880n, operationsReserve: 40_000_000n, unpaidSolObligations: 30_000_000n,
    unspentBuyback: 20_000_000n, proposedSpend: 10_000_000n, proposedFrom: "SOL_REWARDS" as const, proposedCosts: 10_000n, opsCostBudgetRemaining: 50_000n, emergencyStop: false };
  it("passes when balance covers all reserves", () => expect(checkSpendable(base)).toEqual({ ok: true }));
  it("insufficient reserves / unknown balance / over-bucket / cost budget / emergency stop all stop", () => {
    expect(checkSpendable({ ...base, finalizedBalance: 90_000_000n }).ok).toBe(false);
    expect(checkSpendable({ ...base, finalizedBalance: null })).toMatchObject({ reasons: ["BALANCE_UNKNOWN"] });
    expect(checkSpendable({ ...base, proposedSpend: 31_000_000n })).toMatchObject({ reasons: ["SPEND_EXCEEDS_BUCKET"] });
    expect(checkSpendable({ ...base, proposedCosts: 60_000n })).toMatchObject({ reasons: ["COST_BUDGET_EXCEEDED"] });
    expect(checkSpendable({ ...base, emergencyStop: true })).toMatchObject({ reasons: ["EMERGENCY_STOP"] });
  });
  it("an operator gas deposit is not revenue: only decoded collect events create receipts", async () => {
    const s = memoryStore(); expect(await s.receipts()).toEqual([]); // balance growth alone never reaches the ledger
  });
});

describe("signer secret + broadcast recovery", () => {
  it("shape check only; any secret present refuses startup in this phase", () => {
    expect(signerSecretShape(undefined)).toBe("ABSENT");
    expect(signerSecretShape(JSON.stringify(Array(64).fill(1)))).toBe("JSON_64");
    expect(signerSecretShape("not a key")).toBe("INVALID");
    expect(signerStartupGate(undefined)).toEqual({ start: true });
    const g = signerStartupGate(JSON.stringify(Array(64).fill(7)));
    expect(g.start).toBe(false); expect(JSON.stringify(g)).not.toContain("7,7");
  });
  it("uncertain submissions are never re-sent with a new identity", () => {
    const b = { state: "SUBMITTED" as const, signature: "sig", lastValidBlockHeight: 100 };
    expect(canReplace(b, { signatureFound: null, finalizedBlockHeight: 200 })).toBe(false);
    expect(canReplace(b, { signatureFound: false, finalizedBlockHeight: 99 })).toBe(false);
    expect(canReplace(b, { signatureFound: false, finalizedBlockHeight: 101 })).toBe(true);
  });
});
