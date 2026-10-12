// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { verifyTransaction, parseSignature, describeError } from "../../services/mcp-worker/src/verify.mjs";
import { isTransactionVerifierResult, isValidSignature } from "@/lib/tools/transaction-verifier";
import { bucketsFor } from "@/lib/tools/relay";

const SIG = "5".repeat(87); // decodes to 64 bytes? computed below
const PK = "11111111111111111111111111111111";
const PK2 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const sig64 = (() => { // build a real 64-byte base58 string
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (let i = 0; i < 64; i++) n = (n << 8n) | BigInt((i * 37 + 11) & 255);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } return s;
})();
const rpc = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });
const tx = (over: Record<string, unknown> = {}, meta: unknown = { err: null, fee: 5000, computeUnitsConsumed: 1200, logMessages: ["a", "b"] }) => ({
  slot: 300, blockTime: 1760000000, version: 0, meta,
  transaction: { message: { accountKeys: [{ pubkey: PK, signer: true, writable: true, source: "transaction" }, { pubkey: PK2, signer: false, writable: false, source: "lookupTable" }], instructions: [{ programId: PK2 }, { programId: PK2 }] } },
  ...over,
});
function run(responses: Response[]) {
  const calls: string[] = [];
  const fetchImpl = async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body)).params[1].commitment); return responses.shift()!; };
  return verifyTransaction({ signature: sig64, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") }).then((r: unknown) => ({ r, calls }));
}

describe("Transaction Verifier (mock RPC)", () => {
  it("validates 64-byte base58 signatures, rejects whitespace and wrong length", () => {
    expect(isValidSignature(sig64)).toBe(true);
    expect(parseSignature(sig64)).toBe(sig64);
    expect(isValidSignature(sig64.slice(0, 40))).toBe(false);
    expect(isValidSignature(sig64.slice(0, 30) + " " + sig64.slice(31))).toBe(false);
    expect(isValidSignature(sig64.replace(/./, "0"))).toBe(false);
    expect(parseSignature(PK)).toBeNull();
    void SIG;
  });
  it("finalized success: one read, success from meta.err === null, exact fee", async () => {
    const { r, calls } = await run([rpc(tx())]);
    expect(calls).toEqual(["finalized"]);
    expect(r).toMatchObject({ found: true, confirmation: "finalized", execution: "succeeded", slot: 300, version: 0, feeLamports: "5000", feeSol: "0.000005", feePayer: PK, signers: [PK], loadedAddressCount: 1, programIds: [PK2], topLevelInstructionCount: 2 });
    expect(isTransactionVerifierResult(r, sig64)).toBe(true);
  });
  it("finalized failed execution is still finalized", async () => {
    const { r } = await run([rpc(tx({}, { err: { InstructionError: [1, { Custom: 6001 }] }, fee: 5000 }))]);
    expect(r).toMatchObject({ confirmation: "finalized", execution: "failed", computeUnitsConsumed: null, logMessageCount: null });
    expect((r as { error: { summary: string } }).error.summary).toBe("Instruction #1 failed: custom program error 6001");
  });
  it("not found at finalized falls back to confirmed once, then reports ambiguous not-found", async () => {
    const { r, calls } = await run([rpc(null), rpc(null)]);
    expect(calls).toEqual(["finalized", "confirmed"]);
    expect(r).toMatchObject({ found: false, confirmation: null, execution: null, slot: null, feeLamports: null });
    expect(isTransactionVerifierResult(r, sig64)).toBe(true);
  });
  it("confirmed-only transaction is labelled confirmed, not finalized", async () => {
    const { r } = await run([rpc(null), rpc(tx({ version: "legacy", blockTime: null }))]);
    expect(r).toMatchObject({ confirmation: "confirmed", version: "legacy", blockTime: null });
  });
  it("missing meta never becomes 0 or success", async () => {
    const { r } = await run([rpc(tx({}, null))]);
    expect(r).toMatchObject({ execution: "unknown", feeLamports: null, computeUnitsConsumed: null, metaAvailable: false });
  });
  it("unsupported version and provider failures fail closed", async () => {
    await expect(run([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32015 } }))])).rejects.toMatchObject({ kind: "unsupported_version" });
    await expect(run([rpc(tx({ version: 1 }))])).rejects.toMatchObject({ kind: "unsupported_version" });
    await expect(run([new Response("x", { status: 429 })])).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(run([new Response("not json")])).rejects.toMatchObject({ kind: "bad_response" });
  });
  it("bounds error detail length", () => {
    expect(describeError({ Big: "x".repeat(2000) }).detail.length).toBeLessThanOrEqual(501);
  });
  it("all tools share the same visitor and global rate-limit buckets", () => {
    expect(bucketsFor("v").map((b) => [b.bucket, b.limit])).toEqual([["tools:m:v", 6], ["tools:h:v", 40], ["tools:global", 60]]);
  });
});
