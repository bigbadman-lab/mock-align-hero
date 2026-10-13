// Phase L7-B — creator BYOK management + OpenAI connection check. All provider calls are HTTP MOCKS; no real
// OpenAI request is made by this suite. DB tests need MCPX_TEST_PG_URL on a THROWAWAY local Postgres.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { parseKeyring } from "@/lib/byok/crypto";
import { deriveState, runByok, type ByokCtx, type ByokStatus } from "@/lib/byok/core";
import { classify, testOpenAiKey } from "@/lib/byok/openai-test";
import { PROVIDERS } from "@/lib/byok/providers";
import { pgByokStore } from "@/lib/byok/store.pg";
import type { OwnershipStore } from "@/lib/creator-auth/core";
import type { Db } from "@/lib/rewards/store.pg";

const K1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const API_KEY = "sk-test_" + "Q".repeat(40) + "zz99";
const WA = "A".repeat(43) + "1";
const WB = "B".repeat(43) + "2";
const PA = "11111111-1111-4111-8111-111111111111";
const PB = "22222222-2222-4222-8222-222222222222";
const SUSP = "33333333-3333-4333-8333-333333333333";
const ownership: OwnershipStore = {
  async getProduct(id) {
    if (id === PA) return { creationId: PA, creatorWallet: WA, lifecycleState: "active" };
    if (id === PB) return { creationId: PB, creatorWallet: WB, lifecycleState: "active" };
    if (id === SUSP) return { creationId: SUSP, creatorWallet: WA, lifecycleState: "suspended" };
    return null;
  },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const P = PROVIDERS["openai"]!;

describe("L7-B OpenAI status mapping (mocked HTTP)", () => {
  const cases: [string, () => Promise<Response>, string][] = [
    ["200", async () => json(200, { choices: [] }), "ok"],
    ["401 invalid key", async () => json(401, { error: { code: "invalid_api_key" } }), "invalid_key"],
    ["403 permissions (ambiguous)", async () => json(403, { error: { code: "unsupported_country_region_territory" } }), "no_permission"],
    ["429 rate limit", async () => json(429, { error: { code: "rate_limit_exceeded" } }), "rate_limited"],
    ["429 insufficient quota", async () => json(429, { error: { code: "insufficient_quota", type: "insufficient_quota" } }), "no_credit"],
    ["404 model", async () => json(404, { error: { code: "model_not_found" } }), "model_unavailable"],
    ["500", async () => json(500, {}), "provider_error"],
    ["503 opaque", async () => new Response("<html>down</html>", { status: 503 }), "provider_error"],
    ["network error", async () => { throw new TypeError("fetch failed"); }, "provider_error"],
    ["timeout/abort", async () => { throw new DOMException("aborted", "AbortError"); }, "provider_error"],
  ];
  for (const [name, f, want] of cases) it(name, async () => expect(await testOpenAiKey(P, API_KEY, "gpt-4o-mini", f as typeof fetch)).toBe(want));

  it("only 401 is treated as a bad key", () => {
    for (const s of [400, 403, 408, 429, 500, 502, 503]) expect(classify(s, "{}")).not.toBe("invalid_key");
  });
  it("sends a fixed, bounded request to the fixed endpoint only", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await testOpenAiKey(P, API_KEY, "gpt-4.1-mini", (async (url: string, init: RequestInit) => { seen = { url, init }; return json(200, {}); }) as never);
    expect(seen!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen!.init.redirect).toBe("error");
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toEqual({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 });
  });
});

describe("L7-B derived state", () => {
  const base: ByokStatus = { provider: "openai", model: "gpt-4o-mini", status: "configured", enabled: false, revision: 3, hasKey: true, credentialVersion: 2,
    limits: { maxConcurrency: 1, maxPerMinute: 6, maxPerDay: 200, maxInputTokens: 4000, maxOutputTokens: 600 }, updatedAt: "", health: "unchecked", healthCredentialVersion: null, healthCheckedAt: null };
  it("never reports active without enabled + a passing check of the CURRENT key", () => {
    expect(deriveState(null)).toBe("not_connected");
    expect(deriveState(base)).toBe("unchecked");
    expect(deriveState({ ...base, enabled: true, health: "ok", healthCredentialVersion: 1 })).toBe("unchecked"); // old key's result
    expect(deriveState({ ...base, enabled: false, health: "ok", healthCredentialVersion: 2 })).toBe("paused");
    expect(deriveState({ ...base, enabled: true, health: "ok", healthCredentialVersion: 2 })).toBe("active");
    expect(deriveState({ ...base, health: "no_credit", healthCredentialVersion: 2 })).toBe("held");
    expect(deriveState({ ...base, health: "invalid_key", healthCredentialVersion: 2 })).toBe("paused");
    expect(deriveState({ ...base, health: "rate_limited", healthCredentialVersion: 2 })).toBe("provider_error");
    expect(deriveState({ ...base, status: "revoked", hasKey: false })).toBe("revoked");
  });
});

// ---------- DB-backed end-to-end through runByok (throwaway Postgres only) ----------
const URL_ = process.env["MCPX_TEST_PG_URL"];
const d = URL_ && /127\.0\.0\.1|localhost/.test(URL_) ? describe : describe.skip;
d("L7-B BYOK management (throwaway Postgres, mocked OpenAI)", () => {
  let a: postgres.Sql; let store: ReturnType<typeof pgByokStore>;
  const wrap = (s: postgres.Sql): Db => ({ query: async (t, p) => ({ rows: (await s.unsafe(t, (p ?? []) as never[])) as never }) });
  let budget = true; let reply: () => Promise<Response> = async () => json(200, {}); let calls = 0;
  const ctx = (wallet: string | null): ByokCtx => ({ store, ownership, sessionWallet: wallet, keyring: () => parseKeyring(`v1:${K1}`),
    takeTestBudget: async () => budget, fetchImpl: (async () => { calls++; return reply(); }) as never });
  const idem = (n: number) => `idem_${String(n).padStart(16, "0")}`;
  const status = async () => (await store.getStatus(PA))!;

  beforeAll(async () => {
    a = postgres(URL_!, { max: 1, onnotice: () => {} }); store = pgByokStore(wrap(a));
    await a.unsafe("drop schema if exists public cascade; create schema public; grant usage on schema public to public;");
    await a.unsafe("do $$ begin create role anon; exception when others then null; end $$; do $$ begin create role authenticated; exception when others then null; end $$; do $$ begin create role service_role; exception when others then null; end $$;");
    for (const f of ["drizzle/migrations/0000_mcpx_01b_registry_outbox.sql", "drizzle/migrations/0002_mcpx_03b_product_configs.sql", "drizzle/migrations/0014_mcpx_l7a_byok.sql", "drizzle/migrations/0015_mcpx_l7b_byok_health.sql"])
      await a.unsafe(readFileSync(f, "utf8").replace(/--> statement-breakpoint/g, ""));
    for (const [id, w, n] of [[PA, WA, 1], [PB, WB, 2]] as const) {
      await a.unsafe(`insert into public.mcp_creations (id, slug, template_id, template_version, display_name, ticker, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
        values ($1, $2, 'wallet-inspector', 1, 'P', 'P', $3, $4, 'So11111111111111111111111111111111111111112', 'solana-mainnet', $5, 1, now())`,
        [id, `prod-${n}`, w, `${"M".repeat(42)}${n}x`.slice(0, 44), `${"S".repeat(87)}${n}`]);
      await a.unsafe(`insert into public.mcp_product_configs (creation_id, template_id, template_version, lifecycle_state, activated_at) values ($1, 'wallet-inspector', '1.0.0', 'active', now())`, [id]);
    }
  });
  afterAll(async () => { await a.unsafe("drop schema public cascade; create schema public;"); await a.end(); });

  it("auth: signed-out 401; foreign / unknown / suspended indistinguishable 404, before any provider call", async () => {
    expect((await runByok(ctx(null), PA, "test_connection", {})).status).toBe(401);
    for (const [w, p] of [[WB, PA], [WA, "44444444-4444-4444-8444-444444444444"], [WA, SUSP]] as const)
      for (const act of ["get_status", "get_usage", "test_connection", "set_enabled"])
        expect(await runByok(ctx(w), p, act, { enabled: true, expectedRevision: 1 })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(calls).toBe(0);
  });

  it("connect stores no key substring and responses never echo the key", async () => {
    const r = await runByok(ctx(WA), PA, "connect_or_replace", { provider: "openai", apiKey: API_KEY, model: "gpt-4o-mini", idempotencyKey: idem(1), expectedRevision: 1 });
    expect(r.status).toBe(200);
    expect(r.body["state"]).toBe("unchecked");
    expect(JSON.stringify(r.body)).not.toMatch(/sk-|zz99|Q{8}/);
    const row = (await a.unsafe("select key_hint from public.mcpx_ai_credentials"))[0]!;
    expect(row["key_hint"]).toBe("----");
  });

  it("test budget exhausted → 429 without calling OpenAI", async () => {
    budget = false; const before = calls;
    expect((await runByok(ctx(WA), PA, "test_connection", {})).body).toEqual({ error: "rate_limited" });
    expect(calls).toBe(before); budget = true;
  });

  it("resume requires a passing check; 200 → ok, then resume works; rate-limit result never pauses", async () => {
    expect((await runByok(ctx(WA), PA, "set_enabled", { enabled: true, expectedRevision: (await status()).revision })).body).toEqual({ error: "needs_passing_test" });
    reply = async () => json(200, {});
    const t = await runByok(ctx(WA), PA, "test_connection", {});
    expect(t.body).toMatchObject({ health: "ok", state: "paused" });
    expect(JSON.stringify(t.body)).not.toMatch(/sk-|zz99/);
    expect((await runByok(ctx(WA), PA, "set_enabled", { enabled: true, expectedRevision: (await status()).revision })).status).toBe(200);
    expect(deriveState(await status())).toBe("active");
    reply = async () => json(429, { error: { code: "rate_limit_exceeded" } });
    expect((await runByok(ctx(WA), PA, "test_connection", {})).body).toMatchObject({ health: "rate_limited", state: "provider_error" });
    expect((await status()).enabled).toBe(true);
  });

  it("insufficient credit → held, not paused or revoked", async () => {
    reply = async () => json(429, { error: { code: "insufficient_quota" } });
    expect((await runByok(ctx(WA), PA, "test_connection", {})).body).toMatchObject({ health: "no_credit", state: "held" });
    expect(await status()).toMatchObject({ status: "configured", hasKey: true });
  });

  it("confirmed 401 auto-pauses; key is kept (not revoked); can't resume until a new passing check", async () => {
    reply = async () => json(401, { error: { code: "invalid_api_key" } });
    expect((await runByok(ctx(WA), PA, "test_connection", {})).body).toMatchObject({ health: "invalid_key", state: "paused" });
    expect(await status()).toMatchObject({ enabled: false, status: "configured", hasKey: true });
    const audit = await a.unsafe("select action from public.mcpx_ai_audit order by id");
    expect(audit.map((x) => x["action"])).toContain("auto_pause");
    expect((await runByok(ctx(WA), PA, "set_enabled", { enabled: true, expectedRevision: (await status()).revision })).body).toEqual({ error: "needs_passing_test" });
  });

  it("a check result for a key replaced mid-test is dropped", async () => {
    const cred = (await store.loadActiveCredential(PA))!;
    const s = await status();
    expect((await runByok(ctx(WA), PA, "rotate", { provider: "openai", apiKey: API_KEY, idempotencyKey: idem(2), expectedRevision: s.revision })).status).toBe(200);
    expect(await store.recordHealth({ creationId: PA, wallet: WA, credentialVersion: cred.version, health: "ok" })).toBe("stale");
    expect(deriveState(await status())).toBe("unchecked"); // the new key starts unchecked
  });

  it("model change resets the check; limits validated against ceilings", async () => {
    reply = async () => json(200, {});
    await runByok(ctx(WA), PA, "test_connection", {});
    const s = await status();
    const bad = await runByok(ctx(WA), PA, "set_model_and_limits", { model: "gpt-4.1-mini", limits: { ...s.limits, maxPerDay: 99999 }, expectedRevision: s.revision });
    expect(bad.status).toBe(400);
    expect((await runByok(ctx(WA), PA, "set_model_and_limits", { model: "gpt-4.1-mini", limits: s.limits, expectedRevision: s.revision })).status).toBe(200);
    expect(await status()).toMatchObject({ model: "gpt-4.1-mini", health: "unchecked" });
  });

  it("revoke is final; a stale test/resume can't revive it", async () => {
    const cred = (await store.loadActiveCredential(PA))!;
    expect((await runByok(ctx(WA), PA, "revoke_and_remove", {})).status).toBe(200);
    expect(await store.recordHealth({ creationId: PA, wallet: WA, credentialVersion: cred.version, health: "ok" })).toBe("revoked");
    expect((await runByok(ctx(WA), PA, "test_connection", {})).status).toBe(404);
    expect((await runByok(ctx(WA), PA, "set_enabled", { enabled: true, expectedRevision: (await status()).revision })).status).toBe(409);
  });

  it("cross-product isolation: B can't read or change A's integration", async () => {
    expect((await runByok(ctx(WB), PA, "revoke_and_remove", {})).status).toBe(404);
    expect(await store.recordHealth({ creationId: PA, wallet: WB, credentialVersion: 1, health: "ok" })).toBe("not_found");
  });

  it("90-day purge: bounded, idempotent, never touches reserved rows or the audit log", async () => {
    const id = (await a.unsafe("select id from public.mcpx_ai_integrations where creation_id = $1", [PA]))[0]!["id"];
    const cid = (await a.unsafe("select id as cid from public.mcpx_ai_credentials where integration_id = $1 limit 1", [id]))[0]!["cid"];
    const ins = (age: string, st: string, ref: string) => a.unsafe(
      `insert into public.mcpx_ai_usage (integration_id, credential_id, request_ref, model, status, reserved_input, reserved_output, created_at, lease_until)
       values ($1, $2, $3, 'gpt-4o-mini', $4, 1, 1, now() - $5::interval, now())`, [id, cid, ref, st, age]);
    for (let n = 0; n < 5; n++) await ins("91 days", "settled", `old_${n}`.padEnd(16, "x"));
    await ins("120 days", "reserved", "old_reserved_xxxxx");
    await ins("89 days", "settled", "recent_xxxxxxxxxx");
    const auditBefore = (await a.unsafe("select count(*)::int n from public.mcpx_ai_audit"))[0]!["n"];
    expect(await store.purgeUsage(3)).toBe(3);
    expect(await store.purgeUsage(3)).toBe(2);
    expect(await store.purgeUsage(3)).toBe(0);
    const left = (await a.unsafe("select request_ref from public.mcpx_ai_usage order by request_ref")).map((x) => x["request_ref"]);
    expect(left).toEqual(expect.arrayContaining(["old_reserved_xxxxx", "recent_xxxxxxxxxx"]));
    expect((await a.unsafe("select count(*)::int n from public.mcpx_ai_audit"))[0]!["n"]).toBe(auditBefore);
    await expect(store.purgeUsage(0)).rejects.toThrow();
  });
});
