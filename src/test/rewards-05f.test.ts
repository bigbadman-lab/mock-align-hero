// 05-F tests: treasury config validation, buyback checks, payout batching/lifecycle/recovery, native invariant. Fixture labels only.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateTreasury, checkSpend, ROLES, type TreasuryConfig } from "@/lib/rewards/treasury-policy";
import { APPROVED_VENUES, checkQuote, verifyFill, type BuybackPolicy, type Quote } from "@/lib/rewards/buyback";
import { planBatches, transition, canReplace, nativeInvariant, type Recipient } from "@/lib/rewards/payout";
import { decodeFeeEvents } from "@/lib/rewards/pump-events";
import { decodeSharing } from "@/lib/rewards/pump-sharing";
import big from "./fixtures/pump-sharing/sh_4S2UVibM.json";

const A = (n: number) => ("FXq" + "abcdefghjk"[n]).padEnd(32, "1"); // fixture labels, not real addresses
const now = new Date("2026-10-13T00:00:00Z");

describe("05-F treasury config", () => {
  it("default config is non-executable with every role unset", () => {
    const v = validateTreasury(DEFAULT_CONFIG, { now, childFeeWallets: [] });
    expect(v.executable).toBe(false);
    for (const r of ROLES) expect(v.blockers).toContain(`ROLE_UNSET:${r}`);
    expect(v.blockers).toEqual(expect.arrayContaining(["LIMITS_UNSET", "SIGNING_NOT_CONFIGURED", "PAUSED", "NOT_APPROVED", "EXECUTION_NOT_IMPLEMENTED"]));
  });
  it("even a fully filled, approved config stays non-executable in 05-F; shared roles, child-wallet reuse and hot treasury keys flagged", () => {
    const addresses = Object.fromEntries(ROLES.map((r, i) => [r, A(i)])) as TreasuryConfig["addresses"];
    addresses.MCP_DISTRIBUTOR = addresses.MCP_CUSTODY!;
    const c: TreasuryConfig = { ...DEFAULT_CONFIG, addresses, limits: { perTxLamports: 10n, perWindowLamports: 100n, perDayLamports: 1000n, perTxTokenUnits: 5n, maxRecipientsPerBatch: 10 },
      allowlist: { programs: ["P"], mints: ["M"] }, signing: { mode: "HOT_KEY_CAPPED" }, reserves: { operationsMinLamports: 1n }, expiresAt: "2027-01-01T00:00:00Z", paused: false, approval: { by: ["x", "y"], at: "t", digest: "d" } };
    const v = validateTreasury(c, { now, childFeeWallets: [A(1)] });
    expect(v.executable).toBe(false);
    expect(v.blockers).toEqual(["ROLE_ADDRESS_SHARED_WITHOUT_WAIVER:MCP_CUSTODY+MCP_DISTRIBUTOR", "CHILD_WALLET_REUSE", "HOT_KEY_FORBIDDEN_FOR_TREASURIES", "EXECUTION_NOT_IMPLEMENTED"]);
  });
  it("worker spend caps fail closed", () => {
    const l = { perTxLamports: 10n, perWindowLamports: 15n, perDayLamports: 20n, perTxTokenUnits: 1n, maxRecipientsPerBatch: 5 };
    expect(checkSpend(null, { window: 0n, day: 0n }, 1n)).toMatchObject({ reason: "LIMITS_UNSET" });
    expect(checkSpend(l, { window: 0n, day: 0n }, 11n)).toMatchObject({ reason: "PER_TX_CAP" });
    expect(checkSpend(l, { window: 10n, day: 10n }, 6n)).toMatchObject({ reason: "PER_WINDOW_CAP" });
    expect(checkSpend(l, { window: 0n, day: 15n }, 6n)).toMatchObject({ reason: "PER_DAY_CAP" });
    expect(checkSpend(l, { window: 0n, day: 0n }, 10n).ok).toBe(true);
  });
});

describe("05-F buyback", () => {
  const P: BuybackPolicy = { canonicalMint: "MCP", venueAllowlist: ["fx-venue"], programAllowlist: ["FXPROG"], maxQuoteAgeMs: 10_000, maxSlippageBps: 100, maxPriceImpactBps: 300, minBudgetLamports: 1000n, feeAndRentLamports: 5000n, operationsAvailable: 10_000n };
  const B = { id: "w1", lamports: 100_000n, spent: false, approved: true };
  const Q: Quote = { venueId: "fx-venue", programIds: ["FXPROG"], inputLamports: 100_000n, outAmount: 1_000_000n, minOut: 990_000n, priceImpactBps: 50, quotedAtMs: 1000, route: "fixture" };
  it("no venue approved in 05-F; missing mint/venue BLOCKED", () => {
    expect(APPROVED_VENUES).toHaveLength(0);
    expect(checkQuote(B, Q, { ...P, canonicalMint: null }, 2000)).toMatchObject({ reason: "CANONICAL_MINT_UNSET" });
    expect(checkQuote(B, Q, { ...P, venueAllowlist: [] }, 2000)).toMatchObject({ reason: "VENUE_NOT_SELECTED" });
  });
  it("stale quote, price impact, slippage floor, foreign program, spent budget, ops shortfall, dust", () => {
    expect(checkQuote(B, Q, P, 20_000)).toMatchObject({ reason: "QUOTE_STALE" });
    expect(checkQuote(B, { ...Q, priceImpactBps: 301 }, P, 2000)).toMatchObject({ reason: "PRICE_IMPACT_TOO_HIGH" });
    expect(checkQuote(B, { ...Q, minOut: 989_999n }, P, 2000)).toMatchObject({ reason: "MIN_OUT_BELOW_SLIPPAGE_FLOOR" });
    expect(checkQuote(B, { ...Q, programIds: ["FXPROG", "EVIL"] }, P, 2000)).toMatchObject({ reason: "PROGRAM_NOT_ALLOWLISTED" });
    expect(checkQuote({ ...B, spent: true }, Q, P, 2000)).toMatchObject({ reason: "BUDGET_ALREADY_SPENT" });
    expect(checkQuote(B, Q, { ...P, operationsAvailable: 4999n }, 2000)).toMatchObject({ reason: "OPERATIONS_INSUFFICIENT_FOR_FEES" });
    expect(checkQuote({ ...B, lamports: 999n }, { ...Q, inputLamports: 999n }, P, 2000)).toEqual({ kind: "CARRY", reason: "BELOW_MIN_BUDGET" });
    const ok = checkQuote(B, Q, P, 2000), retry = checkQuote(B, { ...Q, quotedAtMs: 1500 }, P, 2000);
    expect(ok.kind === "PREPARED_UNSIGNED" && retry.kind === "PREPARED_UNSIGNED" && ok.intentId === retry.intentId).toBe(true); // retry reuses intent
  });
  it("entitlements only from verified balance delta; quotes and unfinalized fills never count", () => {
    const exp = { mint: "MCP", custodyAccount: "CUST", budgetLamports: 100_000n, minOut: 990_000n };
    const base = { finalized: true, err: null, mint: "MCP", custodyAccount: "CUST", pre: { account: "CUST", mint: "MCP", amount: 5n }, post: { account: "CUST", mint: "MCP", amount: 1_000_005n }, solSpent: 99_000n };
    expect(verifyFill(base, exp)).toEqual({ kind: "VERIFIED", acquired: 1_000_000n, solSpent: 99_000n, unspentLamports: 1000n });
    expect(verifyFill({ ...base, finalized: false }, exp).kind).toBe("UNKNOWN");
    expect(verifyFill({ ...base, err: { x: 1 } }, exp).kind).toBe("FAILED");
    expect(verifyFill({ ...base, post: { ...base.post, amount: 500_005n } }, exp)).toMatchObject({ kind: "MISMATCH", reason: "BELOW_MIN_OUT" });
    expect(verifyFill({ ...base, post: null }, exp).kind).toBe("UNKNOWN");
  });
});

describe("05-F payouts", () => {
  const L = { maxRecipients: 2, rentPerAtaLamports: 2_039_280n, feePerTxLamports: 5000n };
  const r = (o: string, a: bigint, ata: Partial<Recipient["ata"]> = {}): Recipient => ({ owner: o, amount: a, ata: { exists: true, frozen: false, program: "SPL", ...ata } });
  it("deterministic batch ids, bounded size, frozen/unsupported held not dropped, ATA rent from ops", async () => {
    const rs = [r("d", 4n), r("a", 1n, { exists: false }), r("c", 3n, { frozen: true }), r("b", 2n), r("e", 5n, { program: "SYSTEM" })];
    const x = await planBatches("MCP", 100, "bv1", "MCP", rs, L), y = await planBatches("MCP", 100, "bv1", "MCP", [...rs].reverse(), L);
    expect(x.batches.map((b) => b.batchId)).toEqual(y.batches.map((b) => b.batchId));
    expect(x.batches.map((b) => b.recipients.map((q) => q.owner))).toEqual([["a", "b"], ["d"]]);
    expect(x.held.map((h) => h.reason)).toEqual(["RECIPIENT_ACCOUNT_FROZEN", "UNSUPPORTED_ACCOUNT_STATE"]);
    expect(x.total + x.heldTotal).toBe(15n);
    expect(x.opsCost).toBe(2n * 5000n + 2_039_280n);
    await expect(planBatches("SOL", 1, "v", null, [r("a", 1n), r("a", 2n)], L)).rejects.toThrow("duplicate_owner");
  });
  it("no executable transition is reachable", () => {
    expect(() => transition("PLANNED", "AUTHORIZED")).toThrow("EXECUTION_NOT_APPROVED");
    expect(() => transition("PLANNED", "SUBMITTED")).toThrow(/illegal/);
    expect(transition("PLANNED", "FAILED")).toBe("FAILED");
  });
  it("crash rehearsal: replacement allowed only when signature provably never landed and blockhash expired", () => {
    // crash after plan / after unsigned prep: never signed → safe to rebuild
    expect(canReplace({ state: "PREPARED", signature: null, lastValidBlockHeight: 100 }, { signatureFound: null, finalizedBlockHeight: null })).toBe(true);
    // crash just before broadcast (signature stored first): must wait for expiry
    const signed = { state: "SIGNED" as const, signature: "sig", lastValidBlockHeight: 100 };
    expect(canReplace(signed, { signatureFound: false, finalizedBlockHeight: 100 })).toBe(false);
    expect(canReplace(signed, { signatureFound: false, finalizedBlockHeight: 101 })).toBe(true);
    // crash after broadcast before evidence save: tx may have landed
    expect(canReplace({ ...signed, state: "SUBMITTED" }, { signatureFound: true, finalizedBlockHeight: 999 })).toBe(false);
    // RPC unknown → never replace
    expect(canReplace({ ...signed, state: "UNKNOWN" }, { signatureFound: null, finalizedBlockHeight: 999 })).toBe(false);
    expect(canReplace({ state: "SUBMITTED", signature: null, lastValidBlockHeight: null }, { signatureFound: false, finalizedBlockHeight: 999 })).toBe(false);
  });
});

describe("05-F native invariant and source exclusivity", () => {
  const ok = { observedRewardsReceipts: 600_001n, observedOperationsReceipts: 400_000n, solBudget: 300_000n, buybackBudget: 300_001n,
    settledSol: 0n, unsettledSol: 299_000n, solCarry: 1000n, buybackSpent: 0n, buybackUnspent: 300_001n, rewardsTreasuryBalanceDelta: 600_001n };
  it("holds when nothing is settled; plans never reduce the treasury", () => expect(nativeInvariant(ok)).toEqual({ ok: true }));
  it("detects phantom revenue, unknown balances, negative terms and claimed settlement without treasury movement", () => {
    expect(nativeInvariant({ ...ok, solBudget: 300_001n }).ok).toBe(false);
    expect(nativeInvariant({ ...ok, rewardsTreasuryBalanceDelta: null })).toMatchObject({ issues: ["TREASURY_BALANCE_UNKNOWN"] });
    expect(nativeInvariant({ ...ok, settledSol: 299_000n, unsettledSol: 0n })).toMatchObject({ issues: ["TREASURY_BALANCE_MISMATCH"] });
    expect(nativeInvariant({ ...ok, unsettledSol: -1n, solCarry: 300_001n }).ok).toBe(false);
  });
  it("a fee-sharing coin's fees reach only the sharing path; the legacy single-recipient decoder cannot credit them", async () => {
    expect(decodeFeeEvents(big as never).kind).toBe("SKIP");
    expect((await decodeSharing(big as never)).kind).toBe("OK");
  });
});
