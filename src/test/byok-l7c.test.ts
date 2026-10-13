// Phase L7-C — product-scoped AI execution through the real product MCP handler, official MCP client,
// creator BYOK in a THROWAWAY local Postgres (MCPX_TEST_PG_URL) and a MOCKED OpenAI. TEST ONLY fixtures.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
// @ts-expect-error plain JS worker module
import { inspectWallet } from "../../services/mcp-worker/src/inspect.mjs";
import { handleProductMcp, type ExecDeps } from "@/lib/mcp-gateway/server";
import type { ProductConfig, ProductDeps, VerifiedCreation } from "@/lib/mcp-gateway/products";
import { parseKeyring } from "@/lib/byok/crypto";
import { runByok, type ByokCtx } from "@/lib/byok/core";
import { summarise, type AiDeps } from "@/lib/byok/execute";
import { pgByokStore } from "@/lib/byok/store.pg";
import type { OwnershipStore } from "@/lib/creator-auth/core";
import type { Db } from "@/lib/rewards/store.pg";

const K1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const KEY_A = "sk-test_" + "A".repeat(40) + "aaaa";
const KEY_B = "sk-test_" + "B".repeat(40) + "bbbb";
const WA = "A".repeat(43) + "1", WB = "B".repeat(43) + "2";
const PA = "11111111-1111-4111-8111-111111111111"; // TEST ONLY: BYOK active
const PB = "22222222-2222-4222-8222-222222222222"; // TEST ONLY: BYOK configured, different key
const PC = "33333333-3333-4333-8333-333333333333"; // TEST ONLY: no BYOK at all
const TOK: Record<string, string> = { [PA]: "tok-a".padEnd(40, "a"), [PB]: "tok-b".padEnd(40, "b"), [PC]: "tok-c".padEnd(40, "c") };
const ADDR = "So11111111111111111111111111111111111111112";
const WALLETS: Record<string, string> = { [PA]: WA, [PB]: WB, [PC]: WA };

const creations: Record<string, VerifiedCreation> = Object.fromEntries([PA, PB, PC].map((id) => [id, { id, templateId: "wallet-inspector", templateVersion: 1, displayName: `TEST ${id.slice(0, 2)}` }]));
const configs: Record<string, ProductConfig> = Object.fromEntries([PA, PB, PC].map((id) => [id, { creationId: id, templateId: "wallet-inspector", templateVersion: "1.0.0", configVersion: 1, toolConfig: {}, accessMode: "credential_required", lifecycleState: "active" }]));
const deps: ProductDeps = { getVerifiedCreation: async (id) => creations[id] ?? null, getProductConfig: async (id) => configs[id] ?? null, authorizeProduct: async (p, b) => b === TOK[p.creationId] };
const ownership: OwnershipStore = { async getProduct(id) { return WALLETS[id] ? { creationId: id, creatorWallet: WALLETS[id]!, lifecycleState: "active" } : null; } };
const walletRpc = async (_u: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body));
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 10 }, value: b.method === "getBalance" ? 5 : [] } }));
};
const exec: ExecDeps = {
  workerConfig: () => ({ url: "https://worker.invalid", secret: "s".repeat(40) }),
  toolAvailability: async () => ({ available: true, limits: { perVisitorPerMinute: 6, perVisitorPerHour: 40, globalPerMinute: 60 } }),
  takeShared: async () => "ok",
  callWorker: async (_c, payload) => ({ ok: true, out: await inspectWallet({ ...JSON.parse(payload).input, rpcUrl: "https://rpc.invalid", executionId: "test", now: () => new Date("2026-01-01T00:00:00Z"), fetchImpl: walletRpc }) }),
};

const URL_ = process.env["MCPX_TEST_PG_URL"];
const d = URL_ && /127\.0\.0\.1|localhost/.test(URL_) ? describe : describe.skip;
d("L7-C product AI execution (throwaway Postgres, mocked OpenAI)", () => {
  let a: postgres.Sql; let store: ReturnType<typeof pgByokStore>;
  const wrap = (s: postgres.Sql): Db => ({ query: async (t, p) => ({ rows: (await s.unsafe(t, (p ?? []) as never[])) as never }) });
  let openai: (url: string, init: RequestInit) => Promise<Response>;
  const seen: { url: string; auth: string; body: Record<string, unknown> }[] = [];
  const keyring = () => parseKeyring(`v1:${K1}`);
  const ai = (): AiDeps => ({
    getStatus: store.getStatus, loadActiveCredential: store.loadActiveCredential, admit: store.admit, settle: store.settle, recordHealth: store.recordHealth,
    creatorWallet: async (id) => WALLETS[id] ?? null, keyring,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: String((init.headers as Record<string, string>)["authorization"]), body: JSON.parse(String(init.body)) });
      return openai(url, init);
    }) as never,
  });
  const ctx = (w: string): ByokCtx => ({ store, ownership, sessionWallet: w, keyring, takeTestBudget: async () => true, fetchImpl: (async () => new Response("{}", { status: 200 })) as never });
  const okReply = (text = "This wallet holds 5 lamports.") => async () => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), { status: 200 });
  async function client(id: string, token = TOK[id]!) {
    const c = new Client({ name: "l7c-test", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://local.test/api/public/mcp/products/${id}`), {
      fetch: (async (u: string | URL, init?: RequestInit) => handleProductMcp(id, new Request(u, init), deps, exec, ai())) as typeof fetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return c;
  }
  const activate = async (id: string, w: string, key: string, n: number) => {
    await runByok(ctx(w), id, "connect_or_replace", { provider: "openai", apiKey: key, model: "gpt-4o-mini", idempotencyKey: `idem_${String(n).padStart(16, "0")}`, expectedRevision: 1 });
    await runByok(ctx(w), id, "test_connection", {});
    await runByok(ctx(w), id, "set_enabled", { enabled: true, expectedRevision: (await store.getStatus(id))!.revision });
  };

  beforeAll(async () => {
    a = postgres(URL_!, { max: 1, onnotice: () => {} }); store = pgByokStore(wrap(a));
    await a.unsafe("drop schema if exists public cascade; create schema public; grant usage on schema public to public;");
    await a.unsafe("do $$ begin create role anon; exception when others then null; end $$; do $$ begin create role authenticated; exception when others then null; end $$; do $$ begin create role service_role; exception when others then null; end $$;");
    for (const f of ["drizzle/migrations/0000_mcpx_01b_registry_outbox.sql", "drizzle/migrations/0002_mcpx_03b_product_configs.sql", "drizzle/migrations/0014_mcpx_l7a_byok.sql", "docs/pending-migrations/0015_mcpx_l7b_byok_health.sql"])
      await a.unsafe(readFileSync(f, "utf8").replace(/--> statement-breakpoint/g, ""));
    for (const [i, id] of [PA, PB, PC].entries()) { const n = i + 1;
      await a.unsafe(`insert into public.mcp_creations (id, slug, template_id, template_version, display_name, ticker, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
        values ($1, $2, 'wallet-inspector', 1, 'P', 'P', $3, $4, 'So11111111111111111111111111111111111111112', 'solana-mainnet', $5, 1, now())`,
        [id, `prod-${n}`, WALLETS[id]!, `${"M".repeat(42)}${n}x`.slice(0, 44), `${"S".repeat(87)}${n}`]);
      await a.unsafe(`insert into public.mcp_product_configs (creation_id, template_id, template_version, lifecycle_state, activated_at) values ($1, 'wallet-inspector', '1.0.0', 'active', now())`, [id]);
    }
    await activate(PA, WA, KEY_A, 1);
    await runByok(ctx(WB), PB, "connect_or_replace", { provider: "openai", apiKey: KEY_B, model: "gpt-4o-mini", idempotencyKey: "idem_0000000000000002", expectedRevision: 1 }); // saved, never activated
  });
  afterAll(async () => { await a.unsafe("drop schema public cascade; create schema public;"); await a.end(); });
  beforeEach(() => { seen.length = 0; openai = okReply(); });

  it("discovery: ai_summary is advertised only on a product whose BYOK is active", async () => {
    const tools = async (id: string) => (await (await client(id)).listTools()).tools;
    const [ta] = await tools(PA);
    expect(Object.keys((ta!.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("ai_summary");
    for (const id of [PB, PC]) expect(Object.keys(((await tools(id))[0]!.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("ai_summary");
  });

  it("invocation uses THIS product's key via the fixed endpoint; usage is settled; no key in output", async () => {
    const r = await (await client(PA)).callTool({ name: "wallet_inspector", arguments: { address: ADDR, ai_summary: true } });
    const out = r.structuredContent as Record<string, any>;
    expect(out["aiSummary"]).toEqual({ status: "ok", model: "gpt-4o-mini", text: "This wallet holds 5 lamports.", source: "creator_openai_key" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0]!.auth).toBe(`Bearer ${KEY_A}`);
    expect(seen[0]!.body).not.toHaveProperty("tools");
    expect(seen[0]!.body["max_tokens"]).toBe(600);
    expect(JSON.stringify(r)).not.toMatch(/sk-test|AAAAAAAA/);
    expect((await store.getUsage(PA)).today).toMatchObject({ requests: 1, inputTokens: 120, outputTokens: 30 });
  });

  it("non-AI tools work without a key; ai_summary is rejected where not offered", async () => {
    const c = await client(PC);
    expect((await c.callTool({ name: "wallet_inspector", arguments: { address: ADDR } })).isError).toBeFalsy();
    expect((await c.callTool({ name: "wallet_inspector", arguments: { address: ADDR, ai_summary: true } })).isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("product keys are audience-bound and can't manage BYOK; another product's token gets 401", async () => {
    await expect(client(PA, TOK[PB]!)).rejects.toThrow();
    const r = await handleProductMcp(PA, new Request("http://local.test/x", { method: "POST", headers: { authorization: `Bearer ${TOK[PB]}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }), deps, exec, ai());
    expect(r.status).toBe(401);
  });

  it("concurrency cap: 4 simultaneous AI calls with max 1 → exactly one runs, the rest are 'busy'", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    openai = async () => { await gate; return okReply()(); };
    const runs = Array.from({ length: 4 }, () => summarise(ai(), PA, { x: 1 }));
    await new Promise((r) => setTimeout(r, 150)); release();
    const res = await Promise.all(runs);
    expect(res.filter((x) => x.status === "ok")).toHaveLength(1);
    expect(res.filter((x) => x.status === "busy")).toHaveLength(3);
  });

  it("timeouts/network → ambiguous (charged at reservation); 429 never pauses", async () => {
    openai = async () => { throw new TypeError("fetch failed"); };
    expect((await summarise(ai(), PA, { y: 1 })).status).toBe("provider_error");
    const amb = await a.unsafe("select used_output, reserved_output from public.mcpx_ai_usage where status = 'ambiguous'");
    expect(amb[0]!["used_output"]).toBe(amb[0]!["reserved_output"]);
    openai = async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 });
    await new Promise((r) => setTimeout(r, 10));
    expect(["rate_limited", "busy"]).toContain((await summarise(ai(), PA, { z: 1 })).status);
    expect((await store.getStatus(PA))!.enabled).toBe(true);
  });

  it("per-minute cap enforced atomically before any provider call", async () => {
    const s = (await store.getStatus(PA))!;
    await runByok(ctx(WA), PA, "set_model_and_limits", { model: "gpt-4o-mini", limits: { ...s.limits, maxPerMinute: 1 }, expectedRevision: s.revision });
    const before = seen.length;
    expect((await summarise(ai(), PA, { q: 1 })).status).toBe("rate_limited");
    expect(seen.length).toBe(before);
    const s2 = (await store.getStatus(PA))!;
    await runByok(ctx(WA), PA, "set_model_and_limits", { model: "gpt-4o-mini", limits: { ...s2.limits, maxPerMinute: 30 }, expectedRevision: s2.revision });
  });

  it("insufficient credit → held; confirmed 401 during execution → auto-pause, key kept, ai_summary disappears", async () => {
    await a.unsafe("delete from public.mcpx_ai_usage"); // fresh minute window for this test
    openai = async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 });
    expect((await summarise(ai(), PA, { h: 1 })).status).toBe("held");
    await activate(PA, WA, KEY_A, 3); // fresh passing check re-activates
    await a.unsafe("delete from public.mcpx_ai_usage");
    openai = async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 });
    expect((await summarise(ai(), PA, { k: 1 })).status).toBe("invalid_key");
    expect(await store.getStatus(PA)).toMatchObject({ enabled: false, status: "configured", hasKey: true });
    const [t] = (await (await client(PA)).listTools()).tools;
    expect(Object.keys((t!.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("ai_summary");
  });

  it("revoke races an in-flight call: the call finishes once, then nothing more is admitted", async () => {
    await activate(PA, WA, KEY_A, 4);
    await a.unsafe("delete from public.mcpx_ai_usage");
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    openai = async () => { await gate; return okReply()(); };
    const inflight = summarise(ai(), PA, { r: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect((await runByok(ctx(WA), PA, "revoke_and_remove", {})).status).toBe(200);
    release();
    expect((await inflight).status).toBe("ok");
    expect((await summarise(ai(), PA, { r: 2 })).status).toBe("not_available");
    const rows = await a.unsafe("select status from public.mcpx_ai_usage");
    expect(rows.map((x) => x["status"])).toEqual(["settled"]);
  });
});
