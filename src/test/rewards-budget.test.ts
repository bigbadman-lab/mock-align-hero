// @vitest-environment node
import { describe, it, expect } from "vitest";
import { deriveBudgets, balanceCheck, chunkEntitlements, memoryBudgetStore, type FeeRecord } from "../../services/rewards-worker/src/budget";

const cfg = { mint: "MINT", deployer: "DEPLOYER", decimals: 6 };
const E = 1_800_000_000 - (1_800_000_000 % 300);
const fee = (k: string, amount: bigint, o: Partial<FeeRecord> = {}): FeeRecord => ({ eventKey: k, mint: "MINT", recipient: "DEPLOYER", amount, epoch: E, commitment: "finalized", status: "CREDITED", ...o });

describe("fee-backed budgets", () => {
  it("30/30/40 exact and conserved, scales with volume (no fixed cap)", () => {
    const big = 12_345_678_901_234n;
    const { budgets } = deriveBudgets(cfg, [fee("a", 1001n), fee("b", big)], []);
    const b = budgets.get(E)!;
    expect(b.sol + b.buyback + b.ops).toBe(1001n + big);
    expect(b.sol).toBe((1001n * 3000n) / 10000n + (big * 3000n) / 10000n);
  });
  it("forged / foreign records never create budget", () => {
    const { budgets, rejected } = deriveBudgets(cfg, [
      fee("w", 10n ** 9n, { mint: "OTHER" }), fee("c", 10n ** 9n, { recipient: "ATTACKER" }),
      fee("p", 10n ** 9n, { commitment: "confirmed" }), fee("q", 10n ** 9n, { status: "QUARANTINED" }),
      fee("d", 1000n), fee("d", 1000n),
    ], []);
    expect(budgets.get(E)!.sol).toBe(300n); // only the single genuine record, once
    expect(rejected).toHaveLength(5);
  });
  it("token budget only from finalized fills of the right mint/decimals, backed by buyback budget", () => {
    const fills = [
      { signature: "f1", mint: "MINT", epoch: E, tokens: 777n, solSpent: 100n, decimals: 6, finalized: true },
      { signature: "f2", mint: "MINT", epoch: E, tokens: 999n, solSpent: 100n, decimals: 6, finalized: false }, // a quote / pending
      { signature: "f3", mint: "MINT", epoch: E, tokens: 999n, solSpent: 100n, decimals: 9, finalized: true },  // wrong decimals
      { signature: "f4", mint: "MINT", epoch: E, tokens: 999n, solSpent: 10n ** 12n, decimals: 6, finalized: true }, // unbacked
    ];
    expect(deriveBudgets(cfg, [fee("a", 10_000n)], fills).budgets.get(E)!.tokens).toBe(777n);
  });
  it("unrelated deposits don't add budget; external withdrawal/shortfall holds", () => {
    const base = { tokenBalance: 0n, rentExemptMin: 890_880n, unpaidSol: 3_000n, unspentBuyback: 3_000n, opsReserved: 4_000n, unpaidTokens: 0n };
    expect(balanceCheck({ ...base, solBalance: 10n ** 12n }).ok).toBe(true); // big deposit: ok to pay, but budget unchanged
    expect(balanceCheck({ ...base, solBalance: 890_880n + 9_999n })).toEqual({ ok: false, reason: "SOL_SHORTFALL" });
    expect(balanceCheck({ ...base, solBalance: null })).toEqual({ ok: false, reason: "BALANCE_UNKNOWN" });
    expect(balanceCheck({ ...base, solBalance: 10n ** 12n, unpaidTokens: 5n })).toEqual({ ok: false, reason: "TOKEN_SHORTFALL" });
  });
  it("large epoch batches into stable compliant chunks that all reserve within budget", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ owner: `o${String(i).padStart(4, "0")}`, amount: 1000n }));
    const chunks = chunkEntitlements(E, "SOL_PAYOUT", rows, 20);
    expect(chunks).toHaveLength(50);
    expect(chunkEntitlements(E, "SOL_PAYOUT", [...rows].reverse(), 20).map((c) => c.idempotencyKey)).toEqual(chunks.map((c) => c.idempotencyKey));
    const { budgets } = deriveBudgets(cfg, [fee("x", 10_000_000n)], []); // sol 3M ≥ 1M owed
    const st = memoryBudgetStore(budgets);
    for (const c of chunks) expect(await st.reserve({ idempotencyKey: c.idempotencyKey, cycleId: "c", kind: "SOL_PAYOUT", epoch: E, messageSha256: "h", lamports: 20_000n, tokens: 0n, opsCostLamports: 5_000n, lastValidBlockHeight: 1 })).toBe("NEW");
    expect(await st.reserve({ idempotencyKey: chunks[0]!.idempotencyKey, cycleId: "c", kind: "SOL_PAYOUT", epoch: E, messageSha256: "h", lamports: 20_000n, tokens: 0n, opsCostLamports: 5_000n, lastValidBlockHeight: 1 })).toBe("DUPLICATE");
  });
  it("SOL and buyback ledgers are separate; ops reserve pays costs, not holder principal", async () => {
    const st = memoryBudgetStore(deriveBudgets(cfg, [fee("x", 10_000n)], []).budgets); // sol 3000, buyback 3000, ops 4000
    const r = (k: string, kind: "SOL_PAYOUT" | "BUYBACK", lamports: bigint, ops = 0n) => st.reserve({ idempotencyKey: k, cycleId: "c", kind, epoch: E, messageSha256: "h", lamports, tokens: 0n, opsCostLamports: ops, lastValidBlockHeight: 1 });
    expect(await r("s1", "SOL_PAYOUT", 3000n)).toBe("NEW");
    expect(await r("s2", "SOL_PAYOUT", 1n)).toBe("NO_SOL_BUDGET"); // buyback budget not borrowed
    expect(await r("b1", "BUYBACK", 3000n, 4000n)).toBe("NEW");
    expect(await r("b2", "BUYBACK", 0n, 1n)).toBe("NO_BUYBACK_BUDGET");
    st.setState("s1", "EXPIRED_NOT_LANDED"); // provably expired frees budget, nothing else does
    expect(await r("s3", "SOL_PAYOUT", 3000n, 1n)).toBe("NO_OPS_RESERVE");
    expect(await r("s4", "SOL_PAYOUT", 3000n)).toBe("NEW");
  });
});
