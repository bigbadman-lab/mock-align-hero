// Offline tests for unsigned assembly (bun test). No RPC, no signing.
import { describe, expect, it } from "bun:test";
import { Keypair, PublicKey, SystemProgram, VersionedMessage } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { assemble, blockhashExpired, solPayoutIxs, tokenPayoutIxs, wsolUnwrapPlan, batchBySize } from "../src/assembly";

const D = Keypair.generate().publicKey; // public key only
const BH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 };
const opts = { cuLimit: 50_000, cuPriceMicroLamports: 1, allowedSigners: [D.toBase58()] };
const people = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());

describe("assemble", () => {
  it("produces an unsigned v0 message with only the deployer as signer", () => {
    const u = assemble(solPayoutIxs(D, [{ owner: people(1)[0]!, lamports: 5000n }]), D, BH, opts);
    if (u.kind !== "UNSIGNED") throw new Error(u.reason);
    expect(u.signers).toEqual([D.toBase58()]);
    const m = VersionedMessage.deserialize(Buffer.from(u.messageBase64, "base64"));
    expect(m.header.numRequiredSignatures).toBe(1);
  });
  it("refuses unexpected signers, foreign programs, oversize txs and bad CU", () => {
    const other = Keypair.generate().publicKey;
    expect(assemble([SystemProgram.transfer({ fromPubkey: other, toPubkey: D, lamports: 1 })], D, BH, opts)).toMatchObject({ reason: expect.stringContaining("UNEXPECTED_SIGNER") });
    const foreign = { programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) } as never;
    expect(assemble([foreign], D, BH, opts)).toMatchObject({ reason: expect.stringContaining("PROGRAM_NOT_ALLOWED") });
    const big = solPayoutIxs(D, people(60).map((owner) => ({ owner, lamports: 1n })));
    expect(assemble(big, D, BH, opts)).toMatchObject({ kind: "BLOCKED", reason: expect.stringContaining("TX_TOO_LARGE") });
    expect(assemble([], D, BH, { ...opts, cuLimit: 0 })).toEqual({ kind: "BLOCKED", reason: "CU_LIMIT_OUT_OF_RANGE" });
  });
  it("blockhash expiry: unknown height never counts as fresh", () => {
    expect(blockhashExpired(BH, null)).toBe("UNKNOWN"); expect(blockhashExpired(BH, 1001)).toBe(true); expect(blockhashExpired(BH, 1000)).toBe(false);
  });
});

describe("payouts", () => {
  it("SOL batches fit 1232 bytes and cover every recipient once", () => {
    const rows = people(45).map((owner) => ({ owner, lamports: 1000n }));
    const r = batchBySize(rows, (p) => assemble(solPayoutIxs(D, p), D, BH, opts));
    if (r.kind !== "OK") throw new Error();
    expect(r.batches.every((b) => b.bytes <= 1232)).toBe(true);
  });
  it("duplicates / zero amounts / off-curve owners refused; ATA creation counted", () => {
    const [a] = people(1);
    expect(() => solPayoutIxs(D, [{ owner: a!, lamports: 1n }, { owner: a!, lamports: 1n }])).toThrow("duplicate_owner");
    expect(() => solPayoutIxs(D, [{ owner: a!, lamports: 0n }])).toThrow("non_positive_amount");
    const mint = Keypair.generate().publicKey;
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], SystemProgram.programId)[0].toBase58();
    expect(() => tokenPayoutIxs(D, mint, 6, [{ owner: pda, amount: 1n, ataExists: true }])).toThrow("off_curve_owner_requires_review");
    expect(tokenPayoutIxs(D, mint, 6, [{ owner: a!, amount: 1n, ataExists: false }]).atasCreated).toBe(1);
  });
});

describe("WSOL unwrap", () => {
  const ok = { exists: true, amount: 500n, owner: D.toBase58(), delegate: null, closeAuthority: null };
  it("closes only when the balance equals the ledger-accounted amount", () => {
    const r = wsolUnwrapPlan(D, ok, 500n);
    expect(r.kind).toBe("CLOSE");
    if (r.kind === "CLOSE") expect(r.ix.keys[0]!.pubkey.equals(getAssociatedTokenAddressSync(NATIVE_MINT, D, false, TOKEN_PROGRAM_ID))).toBe(true);
  });
  it("unrelated WSOL, unknown balance, delegate or foreign close authority blocks", () => {
    expect(wsolUnwrapPlan(D, ok, 400n)).toEqual({ kind: "BLOCKED", reason: "WSOL_UNACCOUNTED_BALANCE" });
    expect(wsolUnwrapPlan(D, { ...ok, amount: null }, 500n)).toMatchObject({ reason: "WSOL_BALANCE_UNKNOWN" });
    expect(wsolUnwrapPlan(D, { ...ok, delegate: "X" }, 500n)).toMatchObject({ reason: "WSOL_ATA_DELEGATED" });
    expect(wsolUnwrapPlan(D, { ...ok, closeAuthority: "X" }, 500n)).toMatchObject({ reason: "WSOL_CLOSE_AUTHORITY_FOREIGN" });
    expect(wsolUnwrapPlan(D, { ...ok, exists: false }, 0n)).toEqual({ kind: "NOTHING" });
  });
});
