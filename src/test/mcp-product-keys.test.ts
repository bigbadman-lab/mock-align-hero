// TEST ONLY: in-memory key store + fixture products. Real key generation/verification code, official MCP client, mocked worker.
import { describe, expect, it, beforeEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleProductMcp, handleMcp, type ExecDeps } from "@/lib/mcp-gateway/server";
import { authorizeProductKey, generateProductKey, isWellFormedProductKey, keyVerifier, type KeyStore, type StoredKey } from "@/lib/mcp-gateway/keys";
import type { ProductDeps, ProductConfig } from "@/lib/mcp-gateway/products";
import { PLATFORM_DEMO, ADAPTERS, adapterExact } from "@/lib/mcp-gateway/registry";
import { bucketsFor } from "@/lib/tools/relay";

const PEPPER = "p".repeat(64);
const A = "aaaaaaaa-0000-4000-8000-00000000000a"; // TEST ONLY
const B = "bbbbbbbb-0000-4000-8000-00000000000b"; // TEST ONLY
const ADDR = "So11111111111111111111111111111111111111112";

let keys: Map<string, StoredKey>;
let storeDown = false;
const store: KeyStore = { findByVerifier: async (v) => { if (storeDown) throw new Error("down"); return keys.get(v) ?? null; } };
async function issue(creationId: string, opts: { expiresAt?: string } = {}) {
  const k = await generateProductKey(PEPPER, creationId);
  const keyId = crypto.randomUUID();
  keys.set(k.verifier, { keyId, creationId, status: "active", expiresAt: opts.expiresAt ?? null, revokedAt: null });
  return { ...k, keyId };
}
const revoke = (verifier: string) => { const k = keys.get(verifier)!; keys.set(verifier, { ...k, status: "revoked", revokedAt: new Date().toISOString() }); };

let lifecycle: Record<string, ProductConfig["lifecycleState"]>;
const deps: ProductDeps = {
  getVerifiedCreation: async (id) => (id === A || id === B ? { id, templateId: "whale-watch", templateVersion: 1, displayName: `TEST ${id.slice(0, 4)}` } : null),
  getProductConfig: async (id) => ({ creationId: id, templateId: "whale-watch", templateVersion: "1.0.0", configVersion: 1, toolConfig: { minLamports: id === A ? "10000000000" : "100000000" }, accessMode: "credential_required", lifecycleState: lifecycle[id] ?? "active" }),
  authorizeProduct: (p, bearer) => authorizeProductKey(store, PEPPER, p.creationId, bearer),
};

let workerCalls = 0;
let takes: string[] = [];
const exec: ExecDeps = {
  workerConfig: () => ({ url: "https://worker.invalid", secret: "s".repeat(40) }),
  toolAvailability: async () => ({ available: true, limits: { perVisitorPerMinute: 6, perVisitorPerHour: 40, globalPerMinute: 60 } }),
  takeShared: async () => { takes.push("tools"); return takes.length > 3 ? "limited" : "ok"; },
  callWorker: async (_c, payload) => {
    workerCalls++;
    const p = JSON.parse(payload);
    return { ok: true, out: { schema: "mcpx.tool-execution.whale-watch.v1", toolId: "whale_watch", executionId: "e", network: "solana-mainnet", commitment: "confirmed", address: p.input.address, minLamports: p.input.minLamports, readAt: "2026-01-01T00:00:00.000Z", complete: true, coverage: { signaturesSampled: 0, transactionsExamined: 0, transactionsUnavailable: 0, undecodableInstructions: 0 }, transfers: [], warnings: [] } };
  },
};

const post = (id: string, headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, method = "POST") =>
  handleProductMcp(id, new Request("http://local.test/x", { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }), deps, exec);
async function connect(id: string, token: string) {
  const c = new Client({ name: "mcpx-03c-test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://local.test/p/${id}`), {
    fetch: (async (u: string | URL, init?: RequestInit) => handleProductMcp(id, new Request(u, init), deps, exec)) as typeof fetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return c;
}

beforeEach(() => { keys = new Map(); storeDown = false; lifecycle = {}; workerCalls = 0; takes = []; });

describe("product access keys (TEST ONLY fixtures)", () => {
  it("keys are 32 random bytes, well-formed, stored only as an audience-bound verifier", async () => {
    const k = await generateProductKey(PEPPER, A);
    expect(isWellFormedProductKey(k.plaintext)).toBe(true);
    expect(k.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(k.verifier).not.toContain(k.plaintext.slice(8));
    expect(await keyVerifier(PEPPER, B, k.plaintext)).not.toBe(k.verifier);
    expect((await generateProductKey(PEPPER, A)).plaintext).not.toBe(k.plaintext);
    expect(k.displayPrefix).toHaveLength(12);
  });

  it("C01/C02: A's key lists and runs A's one tool; it cannot open B (same template)", async () => {
    const ka = await issue(A);
    const c = await connect(A, ka.plaintext);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["whale_watch"]);
    const r = await c.callTool({ name: "whale_watch", arguments: { address: ADDR } });
    expect(r.isError).toBeFalsy();
    expect(workerCalls).toBe(1);
    await c.close();
    expect((await post(B, { authorization: `Bearer ${ka.plaintext}` })).status).toBe(401);
  });

  it("C03: demo token cannot open A; A key cannot open the demo", async () => {
    process.env["MCPX_MCP_TEST_TOKEN"] = "demo-".padEnd(40, "z");
    await issue(A);
    expect((await post(A, { authorization: `Bearer ${process.env["MCPX_MCP_TEST_TOKEN"]}` })).status).toBe(401);
    const ka = await issue(A);
    const d = await handleMcp(PLATFORM_DEMO, new Request("http://local.test/x", { method: "POST", headers: { authorization: `Bearer ${ka.plaintext}`, "content-type": "application/json" }, body: "{}" }), exec);
    expect(d.status).toBe(401);
  });

  it("C04: missing, malformed, wrong, expired and revoked keys fail closed with zero worker calls", async () => {
    const good = await issue(A);
    const expired = await issue(A, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const revoked = await issue(A); revoke(revoked.verifier);
    for (const h of [{}, { authorization: "Bearer short" }, { authorization: `Basic ${good.plaintext}` }, { authorization: `Bearer ${good.plaintext.slice(0, -1)}X` },
      { authorization: `Bearer ${expired.plaintext}` }, { authorization: `Bearer ${revoked.plaintext}` }]) {
      expect((await post(A, h)).status).toBe(401);
    }
    expect(workerCalls).toBe(0);
  });

  it("C05: rotation — new key accepted, previous key rejected on the very next request of an open session", async () => {
    const old = await issue(A);
    const c = await connect(A, old.plaintext);
    expect((await c.listTools()).tools).toHaveLength(1);
    const next = await issue(A); revoke(old.verifier);
    await expect(c.listTools()).rejects.toBeTruthy();
    expect((await post(A, { authorization: `Bearer ${next.plaintext}` })).status).toBe(200);
    expect(workerCalls).toBe(0);
  });

  it("C06: inactive/suspended/unknown products refuse even a valid key; a key never activates a product", async () => {
    const ka = await issue(A);
    for (const st of ["inactive", "suspended"] as const) { lifecycle[A] = st; expect((await post(A, { authorization: `Bearer ${ka.plaintext}` })).status).toBe(404); }
    expect((await post("cccccccc-0000-4000-8000-00000000000c", { authorization: `Bearer ${ka.plaintext}` })).status).toBe(404);
    expect(workerCalls).toBe(0);
  });

  it("C07: caller overrides of template/threshold/creation are rejected before the worker", async () => {
    const ka = await issue(A);
    const c = await connect(A, ka.plaintext);
    for (const extra of [{ minLamports: "1" }, { templateId: "wallet-inspector" }, { creationId: B }, { rpcUrl: "https://x" }]) {
      expect((await c.callTool({ name: "whale_watch", arguments: { address: ADDR, ...extra } })).isError).toBe(true);
    }
    expect(workerCalls).toBe(0);
    await c.close();
  });

  it("C08: body cap, Origin rules and HTTP method", async () => {
    const ka = await issue(A);
    const h = { authorization: `Bearer ${ka.plaintext}` };
    expect((await post(A, { ...h, "content-length": "9000" })).status).toBe(413);
    expect((await post(A, { ...h, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(A, { ...h, origin: "null" })).status).toBe(403);
    expect((await post(A, { ...h, origin: "https://mcpx.fun" })).status).toBe(200);
    expect((await post(A, h)).status).toBe(200);
    expect((await post(A, h, undefined, "GET")).status).toBe(405);
    expect((await post(A, h, undefined, "DELETE")).status).toBe(405);
  });

  it("C09: two products share one quota budget (no per-product buckets)", async () => {
    expect(bucketsFor("v").every((b) => b.bucket.startsWith("tools:"))).toBe(true);
    const ka = await issue(A), kb = await issue(B);
    const ca = await connect(A, ka.plaintext), cb = await connect(B, kb.plaintext);
    const results = [];
    for (const c of [ca, cb, ca, cb]) results.push((await c.callTool({ name: "whale_watch", arguments: { address: ADDR } })).isError === true);
    expect(results).toEqual([false, false, false, true]); // 4th call limited regardless of product
    expect(workerCalls).toBe(3);
    await ca.close(); await cb.close();
  });

  it("C10: key store failure fails closed (503), not open", async () => {
    const ka = await issue(A);
    storeDown = true;
    expect((await post(A, { authorization: `Bearer ${ka.plaintext}` })).status).toBe(503);
    expect(workerCalls).toBe(0);
  });

  it("C16: a seventh template is registration-only (adapter entry), no transport change", () => {
    ADAPTERS["fixture-seven"] = { ...ADAPTERS["wallet-inspector"]!, templateId: "fixture-seven", toolName: "fixture_seven" };
    expect(adapterExact("fixture-seven", "1.0.0")?.toolName).toBe("fixture_seven");
    delete ADAPTERS["fixture-seven"];
  });
});
