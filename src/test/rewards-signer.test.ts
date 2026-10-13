// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { loadSigner, readLimits, reconcile, executionReadiness, TECHNICAL_LIMITS, type Plan, type Limits } from "../../services/rewards-worker/src/signer";
import { memoryBudgetStore, type EpochBudget } from "../../services/rewards-worker/src/budget";

// Disposable fixture keys generated per run — never a real deployer key.
const kp = Keypair.generate();
const other = Keypair.generate();
const secret = bs58.encode(kp.secretKey);
const env = { MCPX_DEPLOYER_PRIVATE_KEY: secret, MCPX_DEPLOYER_PUBLIC_KEY: kp.publicKey.toBase58() };
const LIMITS: Limits = { maxLamportsPerTx: null, maxLamportsPerCycle: null, maxTokensPerTx: null, ...TECHNICAL_LIMITS };
const EPOCH = 1_800_000_000 - (1_800_000_000 % 300);
const BH = "11111111111111111111111111111111";

// Default: a verified epoch budget large enough for the fixtures (as if derived from finalized fee records).
const memStore = (b: Partial<EpochBudget> = {}) =>
  memoryBudgetStore(new Map([[EPOCH, { sol: 100_000_000n, buyback: 0n, ops: 50_000_000n, tokens: 10n ** 9n, ...b }]]));
const msg = (ixs: import("@solana/web3.js").TransactionInstruction[], payer = kp.publicKey, cu = 200_000, price = 1000) =>
  Buffer.from(new TransactionMessage({ payerKey: payer, recentBlockhash: BH, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...ixs,
  ] }).compileToV0Message().serialize()).toString("base64");
const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
const solPlan = (over: Partial<Plan> = {}): Plan => ({ kind: "SOL_PAYOUT", idempotencyKey: crypto.randomUUID(), cycleId: "c1", epoch: EPOCH, lastValidBlockHeight: 1000,
  rows: [{ owner: a.toBase58(), amount: 1_000_000n }, { owner: b.toBase58(), amount: 2_000_000n }],
  messageBase64: msg([SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: a, lamports: 1_000_000 }), SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: b, lamports: 2_000_000 })]),
  ...over });
const ctx = (store = memStore(), o: Partial<{ limits: Limits | null; emergencyStop: boolean; currentBlockHeight: number | null }> = {}) =>
  ({ limits: LIMITS, emergencyStop: false, currentBlockHeight: 900, store, ...o });

describe("deployer key loading", () => {
  it("derived address matches → validated", () => { const s = loadSigner(env); expect(s.state).toBe("SIGNER_VALIDATED"); expect(s.address).toBe(kp.publicKey.toBase58()); });
  it("wrong key for the configured address → invalid, cannot sign", () => {
    const s = loadSigner({ ...env, MCPX_DEPLOYER_PUBLIC_KEY: other.publicKey.toBase58() });
    expect(s.state).toBe("SIGNER_INVALID"); expect(s.reason).toBe("ADDRESS_MISMATCH"); expect(s.sign).toBeNull();
  });
  it("JSON byte array and garbage are rejected", () => {
    expect(loadSigner({ ...env, MCPX_DEPLOYER_PRIVATE_KEY: JSON.stringify([...kp.secretKey]) }).reason).toBe("PRIVATE_KEY_FORMAT");
    expect(loadSigner({ ...env, MCPX_DEPLOYER_PRIVATE_KEY: "0OIl" }).reason).toBe("PRIVATE_KEY_FORMAT");
    expect(loadSigner({ ...env, MCPX_DEPLOYER_PRIVATE_KEY: bs58.encode(kp.secretKey.slice(0, 32)) }).reason).toBe("PRIVATE_KEY_LENGTH");
  });
  it("tampered secret (pubkey half altered) → inconsistent", () => {
    const t = Uint8Array.from(kp.secretKey); t.set(other.publicKey.toBytes(), 32);
    expect(loadSigner({ ...env, MCPX_DEPLOYER_PRIVATE_KEY: bs58.encode(t) }).state).toBe("SIGNER_INVALID");
  });
  it("missing key → monitor only; legacy env name blocks", () => {
    expect(loadSigner({}).state).toBe("MONITOR_ONLY");
    expect(loadSigner({ ...env, MCPX_NATIVE_DEPLOYER_PRIVATE_KEY: secret }).reason).toBe("LEGACY_KEY_ENV_PRESENT");
  });
  it("no status output ever contains key material", () => {
    for (const e of [env, { ...env, MCPX_DEPLOYER_PUBLIC_KEY: other.publicKey.toBase58() }, { ...env, MCPX_DEPLOYER_PRIVATE_KEY: secret + "x" }]) {
      const out = JSON.stringify(loadSigner(e).describe()) + JSON.stringify(loadSigner(e));
      expect(out).not.toContain(secret.slice(0, 20));
    }
  });
});

describe("signing validated plans (offline fixture key)", () => {
  const s = loadSigner(env);
  it("signs an exact SOL payout and the signature verifies", async () => {
    const st = memStore(); const r = await s.sign!(solPlan(), ctx(st));
    expect(r.ok).toBe(true);
    if (r.ok) { const tx = VersionedTransaction.deserialize(Buffer.from(r.signedBase64, "base64")); expect(bs58.encode(tx.signatures[0]!)).toBe(r.signature); }
    expect([...st.rows.values()][0]!.signature).toBeTruthy();
  });
  it("refuses altered amount, extra recipient, foreign payer", async () => {
    const bad1 = solPlan({ rows: [{ owner: a.toBase58(), amount: 1_000_000n }, { owner: b.toBase58(), amount: 1n }] });
    expect(await s.sign!(bad1, ctx())).toEqual({ ok: false, reason: "RECIPIENT_OR_AMOUNT_MISMATCH" });
    const bad2 = solPlan({ rows: [{ owner: a.toBase58(), amount: 1_000_000n }] });
    expect((await s.sign!(bad2, ctx())).ok).toBe(false);
    const bad3 = solPlan({ messageBase64: msg([SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: a, lamports: 1_000_000 })], other.publicKey) });
    expect(await s.sign!(bad3, ctx())).toEqual({ ok: false, reason: "UNEXPECTED_SIGNER" });
  });
  it("refuses non-allowlisted programs and unproven paths", async () => {
    const evil = { programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) };
    expect((await s.sign!(solPlan({ messageBase64: msg([evil]) }), ctx())).ok).toBe(false);
    for (const kind of ["BUYBACK", "WSOL_UNWRAP", "FEE_COLLECTION"] as const)
      expect(await s.sign!(solPlan({ kind }), ctx())).toEqual({ ok: false, reason: `PATH_NOT_PROVEN:${kind}` });
  });
  it("payout dedupe: same idempotency key is never signed twice", async () => {
    const st = memStore(); const p = solPlan();
    expect((await s.sign!(p, ctx(st))).ok).toBe(true);
    expect(await s.sign!(p, ctx(st))).toEqual({ ok: false, reason: "DUPLICATE_INTENT" });
  });
  it("no ceilings configured: a fee-backed payout signs; an unbacked one is refused", async () => {
    expect(readLimits({})).toEqual({ ok: true, limits: LIMITS });
    expect((await s.sign!(solPlan(), ctx(memStore()))).ok).toBe(true);
    expect(await s.sign!(solPlan(), ctx(memStore({ sol: 2_999_999n })))).toEqual({ ok: false, reason: "NO_SOL_BUDGET" });
    expect(await s.sign!(solPlan({ epoch: EPOCH + 300 }), ctx(memStore()))).toEqual({ ok: false, reason: "NO_EVIDENCE" });
    expect(await s.sign!(solPlan(), ctx(memStore({ ops: 1n })))).toEqual({ ok: false, reason: "NO_OPS_RESERVE" });
  });
  it("cumulative epoch budget: second batch beyond the verified SOL budget is refused", async () => {
    const st = memStore({ sol: 5_000_000n });
    expect((await s.sign!(solPlan(), ctx(st))).ok).toBe(true); // 3M of 5M
    expect(await s.sign!(solPlan(), ctx(st))).toEqual({ ok: false, reason: "NO_SOL_BUDGET" });
  });
  it("optional operator ceilings: invalid blocks, reached holds, raised resumes without double counting", async () => {
    expect(readLimits({ MCPX_REWARDS_MAX_LAMPORTS_PER_TX: "abc" }).ok).toBe(false);
    expect(readLimits({ MCPX_REWARDS_MAX_LAMPORTS_PER_TX: "9", MCPX_REWARDS_MAX_LAMPORTS_PER_CYCLE: "5" }).ok).toBe(false);
    const st = memStore(); const p = solPlan();
    const low = { ...LIMITS, maxLamportsPerTx: 2_000_000n };
    expect(await s.sign!(p, ctx(st, { limits: low }))).toEqual({ ok: false, reason: "OPERATOR_CEILING_REACHED:TX_LAMPORTS" });
    expect(st.rows.size).toBe(0); // held, nothing reserved or forfeited
    expect((await s.sign!(p, ctx(st, { limits: { ...low, maxLamportsPerTx: 3_000_000n } }))).ok).toBe(true);
    expect(st.rows.size).toBe(1);
    expect(await s.sign!(solPlan(), ctx(st, { limits: { ...LIMITS, maxLamportsPerCycle: 5_000_000n } }))).toEqual({ ok: false, reason: "OPERATOR_CEILING_REACHED:CYCLE_LAMPORTS" });
  });
  it("priority-fee ceiling", async () => {
    const p = solPlan({ messageBase64: msg([SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: a, lamports: 1_000_000 }), SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: b, lamports: 2_000_000 })], kp.publicKey, 400_000, 200_000) });
    expect(await s.sign!(p, ctx(memStore(), { limits: { ...LIMITS, maxPriorityFeeLamports: 1000n } }))).toEqual({ ok: false, reason: "PRIORITY_FEE_TOO_HIGH" });
  });
  it("expired blockhash, unknown height, emergency stop, store failure", async () => {
    expect(await s.sign!(solPlan(), ctx(memStore(), { currentBlockHeight: 990 }))).toEqual({ ok: false, reason: "BLOCKHASH_EXPIRED" });
    expect(await s.sign!(solPlan(), ctx(memStore(), { currentBlockHeight: null }))).toEqual({ ok: false, reason: "BLOCK_HEIGHT_UNKNOWN" });
    expect(await s.sign!(solPlan(), ctx(memStore(), { emergencyStop: true }))).toEqual({ ok: false, reason: "EMERGENCY_STOP" });
    const broken = { ...memStore(), reserve: async () => { throw new Error("down"); } };
    expect(await s.sign!(solPlan(), ctx(broken))).toEqual({ ok: false, reason: "INTENT_STORE_UNAVAILABLE" });
  });
  it("token payout: exact TransferChecked from deployer ATA signs; wrong mint refused", async () => {
    const mint = Keypair.generate().publicKey; const P = TOKEN_2022_PROGRAM_ID;
    const src = getAssociatedTokenAddressSync(mint, kp.publicKey, false, P), dst = getAssociatedTokenAddressSync(mint, a, true, P);
    const m = msg([createTransferCheckedInstruction(src, mint, dst, kp.publicKey, 500n, 6, [], P)]);
    const plan: Plan = { kind: "TOKEN_PAYOUT", idempotencyKey: "t1", cycleId: "c2", epoch: EPOCH, lastValidBlockHeight: 1000, messageBase64: m, mint: mint.toBase58(), decimals: 6, rows: [{ owner: a.toBase58(), amount: 500n }] };
    expect(await s.sign!(plan, ctx(memStore({ tokens: 499n })))).toEqual({ ok: false, reason: "NO_TOKEN_BUDGET" }); // more than purchased
    expect((await s.sign!(plan, ctx())).ok).toBe(true);
    expect((await s.sign!({ ...plan, idempotencyKey: "t2", mint: Keypair.generate().publicKey.toBase58() }, ctx())).ok).toBe(false);
  });
});

describe("recovery and readiness", () => {
  it("unknown outcome never allows a retry until the blockhash has provably expired", () => {
    const i = { signature: "sig", lastValidBlockHeight: 100 };
    expect(reconcile(i, { status: "UNKNOWN", finalizedBlockHeight: 200 })).toBe("WAIT");
    expect(reconcile(i, { status: "NOT_FOUND", finalizedBlockHeight: 90 })).toBe("WAIT");
    expect(reconcile(i, { status: "NOT_FOUND", finalizedBlockHeight: 101 })).toBe("EXPIRED_NOT_LANDED");
    expect(reconcile(i, { status: "FINALIZED_OK", finalizedBlockHeight: 101 })).toBe("LANDED");
  });
  it("key presence alone is never execution-ready", () => {
    const base = { signer: "SIGNER_VALIDATED" as const, mintVerified: false, eligibilityApproved: false, snapshotComplete: false, feeOwnershipConfirmed: false,
      intentStoreReady: false, simulationsPassed: false, reservesSufficient: false, operatorAuthorized: false, limitsSet: true, emergencyStop: false };
    expect(executionReadiness(base).state).toBe("SIGNER_VALIDATED");
    const all = { ...base, mintVerified: true, eligibilityApproved: true, snapshotComplete: true, feeOwnershipConfirmed: true, intentStoreReady: true, simulationsPassed: true, reservesSufficient: true, operatorAuthorized: true };
    expect(executionReadiness(all).state).toBe("EXECUTION_READY");
    expect(executionReadiness({ ...all, emergencyStop: true }).state).toBe("EXECUTION_BLOCKED");
    expect(executionReadiness({ ...all, signer: "MONITOR_ONLY" }).state).toBe("MONITOR_ONLY");
  });
});
