// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { checkAccount, classify } from "../../services/mcp-worker/src/account.mjs";
import { isAccountCheckerResult } from "@/lib/tools/account-checker";

const ADDR = "So11111111111111111111111111111111111111112";
const SYS = "11111111111111111111111111111111";
const raw = (text: string, status = 200) => new Response(text, { status });
function run(resp: Response) {
  let calls = 0; let params: any;
  const fetchImpl = async (_u: string, init: RequestInit) => { calls++; params = JSON.parse(String(init.body)).params; return resp; };
  return checkAccount({ address: ADDR, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") }).then((r: any) => ({ r, calls, params }));
}

describe("Account Checker (mock RPC)", () => {
  it("one read, no data downloaded, exact u64 lamports beyond 2^53", async () => {
    const { r, calls, params } = await run(raw(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":7},"value":{"owner":"${SYS}","executable":false,"lamports":18446744073709551615,"space":0,"data":["","base64"]}}}`));
    expect(calls).toBe(1);
    expect(params[1].dataSlice).toEqual({ offset: 0, length: 0 });
    expect(r).toMatchObject({ exists: true, lamports: "18446744073709551615", sol: "18446744073.709551615", space: 0, classification: "system_owned", slot: 7 });
    expect(isAccountCheckerResult(r, ADDR)).toBe(true);
  });
  it("null account is 'no account found', with no invented fields", async () => {
    const { r } = await run(raw(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":7},"value":null}}`));
    expect(r).toMatchObject({ exists: false, owner: null, lamports: null, space: null });
    expect(isAccountCheckerResult(r, ADDR)).toBe(true);
  });
  it("provider failures are errors, never 'not found'", async () => {
    await expect(run(raw("x", 429))).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(run(raw("not json"))).rejects.toMatchObject({ kind: "bad_response" });
    await expect(run(raw(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":7},"value":{"owner":"${SYS}","executable":false,"lamports":1,"space":-1}}}`))).rejects.toMatchObject({ kind: "bad_response" });
  });
  it("classification is generic and executable wins", () => {
    expect(classify(SYS, true)).toBe("executable_program");
    expect(classify("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", false)).toBe("token_2022_owned");
    expect(classify(ADDR, false)).toBe("other_program_owned");
  });
});
