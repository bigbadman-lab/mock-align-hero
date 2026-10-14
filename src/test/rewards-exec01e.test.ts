// @vitest-environment node
// EXEC-01E: fee-collection + buyback signing with DISPOSABLE keys only (never a real deployer key).
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction, createTransferInstruction,
  getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { loadSigner, TECHNICAL_LIMITS, type Plan, type Limits } from "../../services/rewards-worker/src/signer";
import { memoryBudgetStore } from "../../services/rewards-worker/src/budget";
import { disc, PUMP, PUMP_AMM } from "../../services/rewards-worker/src/venue-check";
import { execute, reconcileOpen, memoryExecStore } from "../../services/rewards-worker/src/executor";
import { curveInputFor, BUY_SLIPPAGE_BPS } from "../../services/rewards-worker/src/build";

const kp = Keypair.generate(), me = kp.publicKey;
const signer = loadSigner({ MCPX_DEPLOYER_PRIVATE_KEY: bs58.encode(kp.secretKey), MCPX_DEPLOYER_PUBLIC_KEY: me.toBase58() });
const LIMITS: Limits = { maxLamportsPerTx: null, maxLamportsPerCycle: null, maxTokensPerTx: null, ...TECHNICAL_LIMITS };
const E = 1_800_000_000 - (1_800_000_000 % 300);
const MINT = Keypair.generate().publicKey, OTHER_MINT = Keypair.generate().publicKey;
const BH = "11111111111111111111111111111111";
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const pumpIx = (prog: string, name: string, accts: PublicKey[], tail: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: new PublicKey(prog), keys: accts.map((p) => ({ pubkey: p, isSigner: p.equals(me), isWritable: true })), data: Buffer.concat([Buffer.from(disc(name)), tail]) });
const m64 = (ixs: TransactionInstruction[], payer = me, extraSigner?: Keypair) => {
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs];
  if (extraSigner) all.push(SystemProgram.transfer({ fromPubkey: extraSigner.publicKey, toPubkey: me, lamports: 1 }));
  return Buffer.from(new TransactionMessage({ payerKey: payer, recentBlockhash: BH, instructions: all }).compileToV0Message().serialize()).toString("base64");
};
const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, me, false, TOKEN_PROGRAM_ID);
const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), me.toBuffer()], new PublicKey(PUMP_AMM))[0];
const collectIxs = () => [
  pumpIx(PUMP, "collect_creator_fee", [me, Keypair.generate().publicKey]),
  createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true), vaultAuth, NATIVE_MINT),
  pumpIx(PUMP_AMM, "collect_coin_creator_fee", [me, vaultAuth]),
  createCloseAccountInstruction(wsol, me, me),
];
const buyCurve = (maxSol: bigint, minOut = 1000n, mint = MINT) => [
  createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(mint, me, false, TOKEN_2022_PROGRAM_ID), me, mint, TOKEN_2022_PROGRAM_ID),
  pumpIx(PUMP, "buy", [mint, me], Buffer.concat([u64(minOut), u64(maxSol)])) ];
const buyAmm = (spend: bigint, wrap = spend) => [
  createAssociatedTokenAccountIdempotentInstruction(me, wsol, me, NATIVE_MINT),
  SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: wrap }), createSyncNativeInstruction(wsol),
  pumpIx(PUMP_AMM, "buy_exact_quote_in_v2", [MINT, me], Buffer.concat([u64(spend), u64(5n)])), createCloseAccountInstruction(wsol, me, me) ];
const store = (buyback = 1_000_000n) => memoryBudgetStore(new Map([[E, { sol: 0n, buyback, ops: 50_000_000n, tokens: 0n }]]));
const ctx = (s = store()) => ({ limits: LIMITS, emergencyStop: false, currentBlockHeight: 900, store: s });
const plan = (kind: "FEE_COLLECTION" | "BUYBACK", messageBase64: string, o: Partial<Plan> = {}): Plan =>
  ({ kind, idempotencyKey: `w${E}:${kind}:${Math.random()}`, cycleId: `w${E}`, epoch: E, messageBase64, lastValidBlockHeight: 1000, rows: [], mint: MINT.toBase58(),
    ...(kind === "BUYBACK" ? { budgetLamports: 1_000_000n } : {}), ...o });
const sign = (p: Plan, s = store()) => signer.sign!(p, ctx(s));

describe("E02 fee collection signing", () => {
  it("curve + PumpSwap collection with WSOL handling is signed and persisted as an intent", async () => {
    const s = store(); const p = plan("FEE_COLLECTION", m64(collectIxs()));
    const r = await sign(p, s); expect(r.ok).toBe(true);
    expect(s.rows.get(p.idempotencyKey)).toMatchObject({ kind: "FEE_COLLECTION", lamports: 0n, state: "SIGNED" });
  });
  it.each([
    ["non-fee transfer", () => [...collectIxs(), SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: 1 })], "SYSTEM_IX_NOT_ALLOWED"],
    ["token transfer out", () => [...collectIxs(), createTransferInstruction(wsol, Keypair.generate().publicKey, me, 1)], "TOKEN_IX_NOT_ALLOWED"],
    ["a buy inside a collection", () => [...collectIxs(), ...buyCurve(1n)], "ATA_IX_NOT_ALLOWED"],
    ["collect for another wallet", () => [pumpIx(PUMP, "collect_creator_fee", [Keypair.generate().publicKey])], "COLLECT_NOT_FOR_DEPLOYER"],
    ["unknown Pump instruction", () => [pumpIx(PUMP, "sell", [me])], `VENUE_IX_NOT_ALLOWED:${PUMP}`],
    ["arbitrary program", () => [new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(1) })], "PROGRAM_NOT_ALLOWED"],
    ["WSOL closed to someone else", () => [...collectIxs().slice(0, 3), createCloseAccountInstruction(wsol, Keypair.generate().publicKey, me)], "TOKEN_IX_NOT_ALLOWED"],
  ])("refuses %s", async (_n, ixs, reason) => {
    const r = await sign(plan("FEE_COLLECTION", m64(ixs())));
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason.startsWith(reason)).toBe(true);
  });
  it("refuses a second signer and a wrong fee payer", async () => {
    expect(await sign(plan("FEE_COLLECTION", m64(collectIxs(), me, Keypair.generate())))).toMatchObject({ ok: false, reason: "UNEXPECTED_SIGNER" });
    expect(await sign(plan("FEE_COLLECTION", m64(collectIxs(), Keypair.generate().publicKey)))).toMatchObject({ ok: false, reason: "UNEXPECTED_SIGNER" });
  });
  it("one collection per window: duplicate refused", async () => {
    const s = store(); const p = plan("FEE_COLLECTION", m64(collectIxs()), { idempotencyKey: `w${E}:collect` });
    expect((await sign(p, s)).ok).toBe(true);
    expect(await sign(p, s)).toMatchObject({ ok: false, reason: "DUPLICATE_INTENT" });
  });
});

describe("E03 buyback signing", () => {
  it("bonding-curve buy within budget (max_sol_cost incl. slippage ≤ budget)", async () => {
    const max = curveInputFor(1_000_000n) + (curveInputFor(1_000_000n) * BigInt(BUY_SLIPPAGE_BPS)) / 10_000n;
    expect(max).toBeLessThanOrEqual(1_000_000n);
    expect((await sign(plan("BUYBACK", m64(buyCurve(max))))).ok).toBe(true);
  });
  it("PumpSwap buy with WSOL wrap/unwrap within budget", async () => { expect((await sign(plan("BUYBACK", m64(buyAmm(1_000_000n))))).ok).toBe(true); });
  it.each([
    ["exceeded budget (curve)", () => buyCurve(1_000_001n), "BUY_EXCEEDS_BUDGET"],
    ["exceeded budget (wrap)", () => buyAmm(900_000n, 1_000_001n), "BUY_EXCEEDS_BUDGET"],
    ["wrong mint", () => buyCurve(1000n, 1n, OTHER_MINT), "ATA_IX_NOT_ALLOWED"],
    ["zero minimum out", () => buyCurve(1000n, 0n), "BUY_MIN_OUT_ZERO"],
    ["two buys", () => [...buyCurve(1000n), pumpIx(PUMP, "buy", [MINT, me], Buffer.concat([u64(1n), u64(1n)]))], "EXACTLY_ONE_BUY_REQUIRED"],
    ["wrap to someone else", () => [SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: 5 }), ...buyCurve(1000n)], "SYSTEM_IX_NOT_WRAP_TO_OWN_WSOL"],
    ["sell disguised", () => [pumpIx(PUMP, "sell", [MINT, me], Buffer.concat([u64(1n), u64(1n)]))], `VENUE_IX_NOT_ALLOWED:${PUMP}`],
  ])("refuses %s", async (_n, ixs, reason) => {
    const r = await sign(plan("BUYBACK", m64(ixs())));
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason.startsWith(reason)).toBe(true);
  });
  it("refuses beyond the window's committed buyback budget, and another window's funds", async () => {
    expect(await sign(plan("BUYBACK", m64(buyAmm(1_000_000n))), store(999_999n))).toMatchObject({ ok: false, reason: "NO_BUYBACK_BUDGET" });
    expect(await sign(plan("BUYBACK", m64(buyAmm(1_000_000n)), { epoch: E + 300 }))).toMatchObject({ ok: false, reason: "NO_EVIDENCE" });
    expect(await sign(plan("BUYBACK", m64(buyAmm(1_000_000n)), { budgetLamports: undefined as never }))).toMatchObject({ ok: false, reason: "BUYBACK_BOUNDS_UNSET" });
  });
  it("stale blockhash refused", async () => {
    expect(await sign(plan("BUYBACK", m64(buyAmm(1000n)), { lastValidBlockHeight: 910 }))).toMatchObject({ ok: false, reason: "BLOCKHASH_EXPIRED" });
  });
});

describe("E05 crash/retry: signed ≠ landed, same bytes, no broadcast", () => {
  it("executor with null sender holds signed bytes; reconcile resends identical bytes; landed only with proof", async () => {
    const es = memoryExecStore(); const s = store();
    const p = plan("BUYBACK", m64(buyAmm(1_000_000n)));
    const wrapped = async (pl: Plan) => { const r = await signer.sign!(pl, ctx(s)); if (r.ok) { es.seed({ idempotencyKey: pl.idempotencyKey, kind: "BUYBACK", signature: "", signedBase64: "", lastValidBlockHeight: 1000, rows: [] }); await es.recordSigned(pl.idempotencyKey, r.signature, r.signedBase64); } return r; };
    const o = await execute(wrapped, p, ctx(s), es, null);
    expect(o.state).toBe("SIGNED_HELD");
    const bytes = es.rows.get(p.idempotencyKey)!.signedBase64; const sent: string[] = [];
    const chain = (st: "NOT_FOUND" | "UNKNOWN" | "FINALIZED_OK", proof: Record<string, unknown> | null) => ({ signatureStatus: async () => ({ status: st, slot: st === "FINALIZED_OK" ? 5 : null }), finalizedBlockHeight: async () => 950, settlement: async () => proof });
    expect((await reconcileOpen(es, chain("NOT_FOUND", null), { send: async (b) => { sent.push(b); } }))[0]!.action).toBe("RESENT_SAME_BYTES");
    expect(sent).toEqual([bytes]);
    expect((await reconcileOpen(es, chain("UNKNOWN", null), null))[0]!.action).toBe("WAIT");
    expect((await reconcileOpen(es, chain("FINALIZED_OK", null), null))[0]!.action).toBe("HELD_NO_PROOF");
    expect(es.rows.get(p.idempotencyKey)!.state).toBe("SIGNED");
    // a restart re-running the stage is a duplicate, never a second signature
    expect(await signer.sign!(p, ctx(s))).toMatchObject({ ok: false, reason: "DUPLICATE_INTENT" });
  });
});
