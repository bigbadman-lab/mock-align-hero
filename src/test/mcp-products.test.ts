// TEST ONLY: synthetic product fixtures, injected in-process. Never written to the database or bundled into routes.
// Uses the official MCP client against the real product handler with a mocked worker (fake RPC behind real worker code).
import { describe, expect, it, beforeEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
// @ts-expect-error plain JS worker module
import { inspectWallet } from "../../services/mcp-worker/src/inspect.mjs";
// @ts-expect-error plain JS worker module
import { watchWhales } from "../../services/mcp-worker/src/whale.mjs";
import { handleProductMcp, handleMcp, type ExecDeps } from "@/lib/mcp-gateway/server";
import { parseCreationId, type ProductConfig, type ProductDeps, type VerifiedCreation } from "@/lib/mcp-gateway/products";
import { PLATFORM_DEMO } from "@/lib/mcp-gateway/registry";
import { bucketsFor } from "@/lib/tools/relay";

const A = "11111111-1111-4111-8111-111111111111"; // TEST ONLY whale-watch, 10 SOL
const B = "22222222-2222-4222-8222-222222222222"; // TEST ONLY whale-watch, 0.1 SOL
const C = "33333333-3333-4333-8333-333333333333"; // TEST ONLY wallet-inspector
const D = "44444444-4444-4444-8444-444444444444"; // TEST ONLY inactive
const TOKENS: Record<string, string> = { [A]: "tok-a-".padEnd(40, "a"), [B]: "tok-b-".padEnd(40, "b"), [C]: "tok-c-".padEnd(40, "c"), [D]: "tok-d-".padEnd(40, "d") };
const DEMO_TOKEN = "demo-".padEnd(40, "z");
const ADDR = "So11111111111111111111111111111111111111112";

let creations: Record<string, VerifiedCreation>;
let configs: Record<string, ProductConfig>;
let lookups = 0;
const cfg = (id: string, templateId: string, toolConfig: unknown, lifecycleState: ProductConfig["lifecycleState"] = "active"): ProductConfig => ({
  creationId: id, templateId, templateVersion: "1.0.0", configVersion: 1, toolConfig, accessMode: "credential_required", lifecycleState,
});
const deps: ProductDeps = {
  getVerifiedCreation: async (id) => { lookups++; return creations[id] ?? null; },
  getProductConfig: async (id) => configs[id] ?? null,
  authorizeProduct: async (p, bearer) => bearer === TOKENS[p.creationId],
};

let workerCalls: string[] = [];
let ready = true;
const ONE = 1_000_000_000;
const SYS = "11111111111111111111111111111111";
const rpcOk = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
const whaleRpc = async (_u: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body));
  if (b.method === "getSignaturesForAddress") return rpcOk([{ signature: "sig0", slot: 10 }]);
  return rpcOk({ slot: 10, blockTime: 1760000000, meta: { err: null }, transaction: { message: { instructions: [
    { programId: SYS, parsed: { type: "transfer", info: { source: ADDR, destination: SYS, lamports: ONE } } }, // 1 SOL
  ] } } });
};
const walletRpc = async (_u: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body));
  return rpcOk({ context: { slot: 10 }, value: b.method === "getBalance" ? 5 : [] });
};
const exec: ExecDeps = {
  workerConfig: () => ({ url: "https://worker.invalid", secret: "s".repeat(40) }),
  toolAvailability: async () => (ready ? { available: true, limits: { perVisitorPerMinute: 6, perVisitorPerHour: 40, globalPerMinute: 60 } } : { available: false, reason: "worker_not_ready" }),
  takeShared: async () => "ok",
  callWorker: async (_c, payload) => {
    workerCalls.push(payload);
    const p = JSON.parse(payload);
    const common = { rpcUrl: "https://rpc.invalid", executionId: "test", now: () => new Date("2026-01-01T00:00:00Z") };
    const out = p.toolId === "whale_watch"
      ? await watchWhales({ ...p.input, ...common, fetchImpl: whaleRpc })
      : await inspectWallet({ ...p.input, ...common, fetchImpl: walletRpc });
    return { ok: true, out };
  },
};

const fetchFor = (id: string) => (async (url: string | URL, init?: RequestInit) =>
  handleProductMcp(id, new Request(url, init), deps, exec)) as typeof fetch;
async function connect(id: string, token = TOKENS[id]!) {
  const client = new Client({ name: "mcpx-fixture-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://local.test/api/public/mcp/products/${id}`), {
    fetch: fetchFor(id), requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}
const raw = (id: string, headers: Record<string, string> = {}) =>
  handleProductMcp(id, new Request("http://local.test/x", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), deps, exec);

beforeEach(() => {
  creations = {
    [A]: { id: A, templateId: "whale-watch", templateVersion: 1, displayName: "TEST Alpha Whales" },
    [B]: { id: B, templateId: "whale-watch", templateVersion: 1, displayName: "TEST Beta Whales" },
    [C]: { id: C, templateId: "wallet-inspector", templateVersion: 1, displayName: "TEST Gamma Wallet" },
    [D]: { id: D, templateId: "wallet-inspector", templateVersion: 1, displayName: "TEST Delta" },
  };
  configs = {
    [A]: cfg(A, "whale-watch", { minLamports: "10000000000" }),
    [B]: cfg(B, "whale-watch", { minLamports: "100000000" }),
    [C]: cfg(C, "wallet-inspector", {}),
    [D]: cfg(D, "wallet-inspector", {}, "inactive"),
  };
  workerCalls = []; lookups = 0; ready = true;
});

describe("product-scoped MCP (TEST ONLY fixtures)", () => {
  it("B01/B02: only canonical UUIDs are accepted; malformed IDs never hit the store or worker", async () => {
    expect(parseCreationId(A)).toBe(A);
    for (const bad of ["alpha-whales", "AAAAAAAA-1111-4111-8111-111111111111", `${A} `, "1", "' OR 1=1 --"]) {
      expect(parseCreationId(bad)).toBeNull();
      expect((await raw(bad, { authorization: `Bearer ${TOKENS[A]}` })).status).toBe(404);
    }
    expect((await raw("99999999-9999-4999-8999-999999999999", { authorization: "Bearer x".padEnd(40, "x") })).status).toBe(404);
    expect(lookups).toBe(1);
    expect(workerCalls).toHaveLength(0);
  });

  it("B03: inactive, suspended, missing config and missing creation are all not found", async () => {
    expect((await raw(D, { authorization: `Bearer ${TOKENS[D]}` })).status).toBe(404);
    configs[A] = { ...configs[A]!, lifecycleState: "suspended" };
    expect((await raw(A, { authorization: `Bearer ${TOKENS[A]}` })).status).toBe(404);
    delete configs[B];
    expect((await raw(B, { authorization: `Bearer ${TOKENS[B]}` })).status).toBe(404);
    delete creations[C];
    expect((await raw(C, { authorization: `Bearer ${TOKENS[C]}` })).status).toBe(404);
    expect(workerCalls).toHaveLength(0);
  });

  it("B04: template mismatch, version mismatch and invalid tool_config fail closed", async () => {
    const h = { authorization: `Bearer ${TOKENS[A]}` };
    configs[A] = { ...configs[A]!, templateId: "wallet-inspector" };
    expect((await raw(A, h)).status).toBe(404);
    configs[A] = { ...cfg(A, "whale-watch", { minLamports: "10000000000" }), templateVersion: "2.0.0" };
    expect((await raw(A, h)).status).toBe(404);
    for (const bad of [{ minLamports: "5" }, { minLamports: "10000000000", rpcUrl: "https://x" }, [], "x", null]) {
      configs[A] = cfg(A, "whale-watch", bad);
      expect((await raw(A, h)).status).toBe(404);
    }
    creations[A] = { ...creations[A]!, templateVersion: 2 };
    configs[A] = cfg(A, "whale-watch", { minLamports: "10000000000" });
    expect((await raw(A, h)).status).toBe(404);
    expect(workerCalls).toHaveLength(0);
  });

  it("B07/B08: official client sees exactly one tool; same-template products keep their own settings", async () => {
    const a = await connect(A);
    const b = await connect(B);
    const ta = (await a.listTools()).tools, tb = (await b.listTools()).tools;
    expect(ta.map((t) => t.name)).toEqual(["whale_watch"]);
    expect(tb.map((t) => t.name)).toEqual(["whale_watch"]);
    expect(ta[0]!.description).toContain("TEST Alpha Whales");
    expect(tb[0]!.description).toContain("TEST Beta Whales");
    expect(Object.keys((ta[0]!.inputSchema as { properties: object }).properties)).toEqual(["address"]); // threshold is server-fixed
    const ra = await a.callTool({ name: "whale_watch", arguments: { address: ADDR } });
    const rb = await b.callTool({ name: "whale_watch", arguments: { address: ADDR } });
    expect(ra.isError).toBeFalsy();
    expect(rb.isError).toBeFalsy();
    expect(JSON.parse(workerCalls[0]!).input.minLamports).toBe("10000000000");
    expect(JSON.parse(workerCalls[1]!).input.minLamports).toBe("100000000");
    // 1 SOL transfer: below Alpha's 10 SOL, above Beta's 0.1 SOL.
    expect((ra.structuredContent as { transfers: unknown[] }).transfers).toHaveLength(0);
    expect((rb.structuredContent as { transfers: unknown[] }).transfers).toHaveLength(1);
    await a.close(); await b.close();
  });

  it("B09/B10: different template has its own tool; wrong tool names and smuggled fields never change dispatch", async () => {
    const c = await connect(C);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["wallet_inspector"]);
    const wrong = await c.callTool({ name: "whale_watch", arguments: { address: ADDR } }).then((r) => r.isError === true, () => true);
    expect(wrong).toBe(true);
    const smuggled = await c.callTool({ name: "wallet_inspector", arguments: { address: ADDR, templateId: "whale-watch", creationId: A, minLamports: "1" } });
    expect(smuggled.isError).toBe(true);
    expect(workerCalls).toHaveLength(0);
    const ok = await c.callTool({ name: "wallet_inspector", arguments: { address: ADDR } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(workerCalls[0]!).toolId).toBe("wallet_inspector");
    await c.close();
  });

  it("B11/B12: missing/wrong/other-product/demo tokens and forbidden Origin rejected before execution; no-Origin allowed", async () => {
    process.env["MCPX_MCP_TEST_TOKEN"] = DEMO_TOKEN;
    expect((await raw(A)).status).toBe(401);
    expect((await raw(A, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await raw(A, { authorization: `Bearer ${TOKENS[B]}` })).status).toBe(401);
    expect((await raw(A, { authorization: `Bearer ${DEMO_TOKEN}` })).status).toBe(401);
    expect((await raw(A, { authorization: `Basic ${TOKENS[A]}` })).status).toBe(401);
    expect((await raw(A, { authorization: `Bearer ${TOKENS[A]}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await raw(A, { authorization: `Bearer ${TOKENS[A]}` })).status).toBe(200);
    expect((await raw(A, { authorization: `Bearer ${TOKENS[A]}`, origin: "https://mcpx.fun" })).status).toBe(200);
    expect(workerCalls).toHaveLength(0);
    // Product tokens do not open the platform demo.
    const demo = await handleMcp(PLATFORM_DEMO, new Request("http://local.test/x", { method: "POST", headers: { authorization: `Bearer ${TOKENS[A]}`, "content-type": "application/json" }, body: "{}" }), exec);
    expect(demo.status).toBe(401);
  });

  it("B13: initialize negotiates protocol 2025-11-25", async () => {
    const r = await raw(A, { authorization: `Bearer ${TOKENS[A]}` });
    expect(r.status).toBe(200);
    const init = await handleProductMcp(A, new Request("http://local.test/x", { method: "POST", headers: { authorization: `Bearer ${TOKENS[A]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) }), deps, exec);
    expect(await init.text()).toContain('"protocolVersion":"2025-11-25"');
  });

  it("B14/B15: buckets are shared (no product dimension); worker not ready and store failure are distinct fail-closed errors", async () => {
    expect(bucketsFor("v").map((b) => b.bucket)).toEqual(["tools:m:v", "tools:h:v", "tools:global"]);
    ready = false;
    expect((await raw(A, { authorization: `Bearer ${TOKENS[A]}` })).status).toBe(503);
    ready = true;
    const broken: ProductDeps = { ...deps, getVerifiedCreation: async () => { throw new Error("db down"); } };
    const r = await handleProductMcp(A, new Request("http://local.test/x", { method: "POST", headers: { authorization: `Bearer ${TOKENS[A]}` }, body: "{}" }), broken, exec);
    expect(r.status).toBe(503);
    expect(workerCalls).toHaveLength(0);
  });

  it("production wiring denies when the key pepper is not configured", async () => {
    const saved = process.env["MCPX_PRODUCT_KEY_PEPPER"];
    delete process.env["MCPX_PRODUCT_KEY_PEPPER"];
    const { productionProductDeps } = await import("@/lib/mcp-gateway/products.server");
    expect(await productionProductDeps.authorizeProduct({} as never, TOKENS[A]!)).toBe(false);
    if (saved) process.env["MCPX_PRODUCT_KEY_PEPPER"] = saved;
  });
});
