// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readSender, rpcSender } from "../../services/rewards-worker/src/sender";

const env = (m: Record<string, string>) => (k: string) => m[k] ?? null;
const ok = async () => new Response(JSON.stringify({ result: "sig" }), { status: 200 });

describe("rewards broadcast switch", () => {
  it("is off unless MCPX_REWARDS_BROADCAST=1", () => {
    expect(readSender(env({ MCPX_REWARDS_RPC_URL: "https://rpc" }), ok)).toBeNull();
    expect(readSender(env({ MCPX_REWARDS_BROADCAST: "0", MCPX_REWARDS_RPC_URL: "https://rpc" }), ok)).toBeNull();
  });
  it("is off without an RPC url even when switched on", () => {
    expect(readSender(env({ MCPX_REWARDS_BROADCAST: "1" }), ok)).toBeNull();
  });
  it("sends exactly the persisted bytes and never asks the RPC to retry", async () => {
    let body: any = null;
    const s = rpcSender("https://rpc", async (_u, i) => { body = JSON.parse(i.body); return ok(); });
    await s.send("QUJD");
    expect(body.method).toBe("sendTransaction");
    expect(body.params[0]).toBe("QUJD");
    expect(body.params[1].maxRetries).toBe(0);
  });
  it("throws on RPC error so reconcile decides", async () => {
    const s = rpcSender("https://rpc", async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 200 }));
    await expect(s.send("QUJD")).rejects.toThrow("bad");
  });
});
