// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { scanToken, normalizeMint } from "../../services/mcp-worker/src/scan.mjs";
import { isTokenScannerResult } from "@/lib/tools/token-scanner";

const MINT = "So11111111111111111111111111111111111111112";
const AUTH = "11111111111111111111111111111111";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const res = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });
const mintAcct = (owner: string, info: Record<string, unknown>) => ({ owner, data: { parsed: { type: "mint", info: { isInitialized: true, decimals: 6, supply: "18446744073709551615", mintAuthority: AUTH, freezeAuthority: null, ...info } } } });
function run(acct: Response, supply: Response = res({ context: { slot: 101 }, value: { amount: "18446744073709551615", decimals: 6 } })) {
  const fetchImpl = async (_u: string, init: RequestInit) => (JSON.parse(String(init.body)).method === "getAccountInfo" ? acct : supply);
  return scanToken({ mint: MINT, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") });
}

describe("Token Scanner (mock RPC)", () => {
  it("SPL mint: exact max-u64 supply, authority present vs revoked, supply cross-check", async () => {
    const r = await run(res({ context: { slot: 100 }, value: mintAcct(SPL, {}) }));
    expect(r).toMatchObject({ status: "mint", program: "spl-token", decimals: 6, supplyRaw: "18446744073709551615", supplyUi: "18446744073709.551615", mintAuthority: AUTH, freezeAuthority: null, extensions: null, accountSlot: 100 });
    expect(r.supplyCheck).toEqual({ status: "ok", slot: 101, supplyRaw: "18446744073709551615", matches: true });
    expect(isTokenScannerResult(r, MINT)).toBe(true);
  });
  it("Token-2022: decoded and unparseable extensions; unknown never shown as absent", async () => {
    const r = await run(res({ context: { slot: 5 }, value: mintAcct(T22, { extensions: [{ extension: "transferFeeConfig", state: { a: 1 } }, { extension: "unparseableExtension" }] }) }));
    expect(r.program).toBe("token-2022");
    expect(r.extensions).toEqual([{ name: "transferFeeConfig", decoded: true, state: '{"a":1}' }, { name: "unparseableExtension", decoded: false, state: null }]);
    expect(r.extensionsComplete).toBe(false);
  });
  it("categorises non-mints: missing, wallet/program, token holding account", () => {
    expect(normalizeMint(null).status).toBe("not_found");
    expect(normalizeMint({ owner: AUTH, data: ["", "base64"] }).status).toBe("not_token_program");
    expect(normalizeMint({ owner: SPL, data: { parsed: { type: "account", info: {} } } })).toMatchObject({ status: "not_a_mint", accountType: "account" });
  });
  it("non-mint results carry no supply or decimals", async () => {
    const r = await run(res({ context: { slot: 1 }, value: null }));
    expect(r).toMatchObject({ status: "not_found", supplyRaw: null, decimals: null });
    expect(r.supplyCheck.status).toBe("not_applicable");
    expect(isTokenScannerResult(r, MINT)).toBe(true);
  });
  it("supply read failure or mismatch is reported, not hidden", async () => {
    const a = await run(res({ context: { slot: 1 }, value: mintAcct(SPL, {}) }), new Response("x", { status: 429 }));
    expect(a.supplyCheck.status).toBe("unavailable");
    const b = await run(res({ context: { slot: 1 }, value: mintAcct(SPL, {}) }), res({ context: { slot: 2 }, value: { amount: "5" } }));
    expect(b.supplyCheck).toMatchObject({ matches: false, supplyRaw: "5" });
  });
  it("account read failures and malformed mint data fail closed", async () => {
    await expect(run(new Response("x", { status: 429 }))).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(run(res({ context: { slot: 1 }, value: mintAcct(SPL, { supply: 12.5 }) }))).rejects.toMatchObject({ kind: "bad_response" });
  });
});
