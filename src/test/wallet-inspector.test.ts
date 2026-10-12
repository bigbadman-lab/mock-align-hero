// MOCK-ONLY unit tests (injected fake RPC). These never count as live end-to-end evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { inspectWallet, formatUnits, parseAddress, PROGRAMS } from "../../services/mcp-worker/src/inspect.mjs";
import { isValidSolanaAddress, isWalletInspectorResult } from "@/lib/tools/wallet-inspector";

const ADDR = "11111111111111111111111111111111"; // System Program id: a valid 32-byte key
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ok = (slot: number, value: unknown) => res(200, { jsonrpc: "2.0", id: 1, result: { context: { slot }, value } });
const acct = (mint: string, amount: string, decimals: number) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } });

function fakeRpc(handlers: { balance?: () => Response; spl?: () => Response; t22?: () => Response }) {
  return async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    if (b.method === "getBalance") return (handlers.balance ?? (() => ok(10, 0)))();
    const prog = b.params[1].programId;
    return prog === PROGRAMS.splToken ? (handlers.spl ?? (() => ok(11, [])))() : (handlers.t22 ?? (() => ok(12, [])))();
  };
}
const run = (h: Parameters<typeof fakeRpc>[0]) => inspectWallet({ address: ADDR, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl: fakeRpc(h), now: () => new Date("2026-01-01T00:00:00Z") });

describe("Wallet Inspector (mock RPC)", () => {
  it("uses the official Token-2022 program id from @solana/spl-token", () => {
    expect(PROGRAMS.splToken).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(PROGRAMS.token2022).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });
  it("formats integer amounts exactly, without floats", () => {
    expect(formatUnits("1500000000", 9)).toBe("1.5");
    expect(formatUnits("123456789012345678901234567890", 6)).toBe("123456789012345678901234.56789");
    expect(formatUnits("0", 9)).toBe("0");
  });
  it("rejects malformed addresses with a real key parser", () => {
    expect(parseAddress("not-an-address")).toBeNull();
    expect(parseAddress("1".repeat(44))).toBeNull();
    expect(isValidSolanaAddress(ADDR)).toBe(true);
    expect(isValidSolanaAddress("O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0")).toBe(false);
  });
  it("zero balance and zero tokens only after all queries succeed", async () => {
    const r = await run({});
    expect(r.partial).toBe(false);
    expect(r.solBalance).toEqual({ lamports: "0", solUi: "0" });
    expect(r.tokenHoldings).toEqual([]);
    expect(r.sourceSlots).toEqual({ balance: 10, splToken: 11, token2022: 12 });
    expect(isWalletInspectorResult(r, ADDR)).toBe(true);
  });
  it("aggregates accounts by mint with BigInt", async () => {
    const r = await run({ spl: () => ok(11, [acct(ADDR, "9007199254740993", 0), acct(ADDR, "1", 0)]) });
    expect(r.tokenHoldings[0]).toMatchObject({ amountRaw: "9007199254740994", tokenAccounts: 2, program: PROGRAMS.splToken });
  });
  it("one token program failing yields partial, never zero tokens", async () => {
    const r = await run({ t22: () => res(429, {}) });
    expect(r.partial).toBe(true);
    expect(r.coverage.token2022).toBe(false);
    expect(r.sourceSlots.token2022).toBeNull();
    expect(r.warnings[0].kind).toBe("rate_limited");
  });
  it("all queries failing is an error, not an empty wallet", async () => {
    const fail = () => res(500, {});
    await expect(run({ balance: fail, spl: fail, t22: fail })).rejects.toMatchObject({ kind: "provider_error" });
  });
  it("more than 500 token accounts is refused as too large", async () => {
    const r = await run({ spl: () => ok(11, Array.from({ length: 501 }, () => acct(ADDR, "1", 0))) });
    expect(r.partial).toBe(true);
    expect(r.warnings[0].kind).toBe("too_large");
  });
  it("proxy shape check rejects a response for a different address", async () => {
    const r = await run({});
    expect(isWalletInspectorResult({ ...r, address: "So11111111111111111111111111111111111111112" }, ADDR)).toBe(false);
  });
});
