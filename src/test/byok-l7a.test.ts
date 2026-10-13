// Phase L7-A — BYOK foundation. Pure tests always run. DB tests need MCPX_TEST_PG_URL pointing at a THROWAWAY
// local Postgres; they recreate the public schema and apply 0000, 0002, then pending 0014.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { aadFor, open, parseKeyring, seal, ByokCryptoError } from "@/lib/byok/crypto";
import { runByok, redact, type ByokStore, type ByokCtx } from "@/lib/byok/core";
import { DEFAULT_LIMITS, PROVIDERS, getProvider, validateLimits } from "@/lib/byok/providers";
import { pgByokStore } from "@/lib/byok/store.pg";
import type { OwnershipStore } from "@/lib/creator-auth/core";
import type { Db } from "@/lib/rewards/store.pg";

const K1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const API_KEY = "sk-test_" + "A".repeat(40) + "wxyz";
const WA = "7".repeat(32 + 8).replace(/7/g, "A").slice(0, 43) + "1"; // fake base58 wallets
const WB = "B".repeat(43) + "2";
const PA = "11111111-1111-4111-8111-111111111111";
const PB = "22222222-2222-4222-8222-222222222222";
const SUSP = "33333333-3333-4333-8333-333333333333";

describe("L7-A crypto", () => {
  it("accepts a platform-generated alphanumeric secret as v1 and rejects short ones", async () => {
    const gen = "a".repeat(30) + "B9".repeat(17);
    const ring = await parseKeyring(gen);
    expect(ring.active).toBe("v1");
    const s = await seal(ring, API_KEY, aadFor(PA, "r"));
    expect(await open(await parseKeyring(gen), s, aadFor(PA, "r"))).toBe(API_KEY);
    await expect(parseKeyring("abc123")).rejects.toThrow("keyring_invalid");
  });
  it("round-trips only with the right keyring, version and product binding", async () => {
    const ring = await parseKeyring(`v1:${K1}`);
    const s = await seal(ring, API_KEY, aadFor(PA, "idem_aaaaaaaaaaaaaaaa"));
    expect(new TextDecoder().decode(s.ciphertext)).not.toContain(API_KEY);
    expect(await open(ring, s, aadFor(PA, "idem_aaaaaaaaaaaaaaaa"))).toBe(API_KEY);
    await expect(open(ring, s, aadFor(PB, "idem_aaaaaaaaaaaaaaaa"))).rejects.toThrow("decrypt_failed"); // copied to another product
    const t = new Uint8Array(s.ciphertext); t[0] = t[0]! ^ 1;
    await expect(open(ring, { ...s, ciphertext: t }, aadFor(PA, "idem_aaaaaaaaaaaaaaaa"))).rejects.toThrow("decrypt_failed");
    await expect(open(ring, { ...s, ciphertext: new Uint8Array(3) }, aadFor(PA, "idem_aaaaaaaaaaaaaaaa"))).rejects.toThrow("decrypt_failed");
    await expect(open(await parseKeyring(`v2:${K2}`), s, aadFor(PA, "idem_aaaaaaaaaaaaaaaa"))).rejects.toThrow("unknown_key_version");
  });
  it("rotation: new entries encrypt, old versions still decrypt", async () => {
    const old = await seal(await parseKeyring(`v1:${K1}`), API_KEY, aadFor(PA, "r"));
    const ring = await parseKeyring(`v2:${K2},v1:${K1}`);
    expect(ring.active).toBe("v2");
    expect(await open(ring, old, aadFor(PA, "r"))).toBe(API_KEY);
    expect((await seal(ring, API_KEY, aadFor(PA, "r"))).kekVersion).toBe("v2");
  });
  it("missing or malformed keyring fails closed", async () => {
    await expect(parseKeyring(undefined)).rejects.toBeInstanceOf(ByokCryptoError);
    await expect(parseKeyring("v1:short")).rejects.toThrow("keyring_invalid");
    await expect(parseKeyring(`v1:${K1},v1:${K2}`)).rejects.toThrow("keyring_invalid");
  });
});

describe("L7-A providers and limits", () => {
  it("OpenAI only, fixed https endpoint, no user base URL", () => {
    expect(Object.keys(PROVIDERS)).toEqual(["openai"]);
    expect(PROVIDERS["openai"]!.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(getProvider("anthropic")).toBeNull();
    expect(getProvider("__proto__")).toBeNull();
  });
  it("limits are bounded by server ceilings", () => {
    expect(validateLimits(DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
    expect(validateLimits({ ...DEFAULT_LIMITS, maxOutputTokens: 1025 })).toBeNull();
    expect(validateLimits({ ...DEFAULT_LIMITS, maxConcurrency: 5 })).toBeNull();
    expect(validateLimits({ ...DEFAULT_LIMITS, baseUrl: "http://169.254.169.254" })).toBeNull();
  });
  it("redact removes keys and ciphertext", () => {
    const r = JSON.stringify(redact({ apiKey: API_KEY, nested: { msg: `bad ${API_KEY}` }, ciphertext: "x" }));
    expect(r).not.toContain(API_KEY.slice(3));
  });
});

// Records store calls; used to prove authorization happens before any store access.
function spyStore() {
  const calls: string[] = [];
  const store = new Proxy({}, { get: (_, k) => async () => { calls.push(String(k)); return k === "getStatus" ? null : "ok"; } }) as ByokStore;
  return { store, calls };
}
const ownership: OwnershipStore = {
  async getProduct(id) {
    if (id === PA) return { creationId: PA, creatorWallet: WA, lifecycleState: "active" };
    if (id === PB) return { creationId: PB, creatorWallet: WB, lifecycleState: "inactive" };
    if (id === SUSP) return { creationId: SUSP, creatorWallet: WA, lifecycleState: "suspended" };
    return null;
  },
};
const ctxOf = (store: ByokStore, wallet: string | null): ByokCtx => ({ store, ownership, sessionWallet: wallet, keyring: () => parseKeyring(`v1:${K1}`) });

describe("L7-A authorization", () => {
  it("rejects unauthenticated, foreign, forged, suspended and unlaunched products before touching the store", async () => {
    const { store, calls } = spyStore();
    expect((await runByok(ctxOf(store, null), PA, "get_status", {})).status).toBe(401);
    expect((await runByok(ctxOf(store, WB), PA, "get_status", {})).status).toBe(404); // creator B on A's product
    expect((await runByok(ctxOf(store, WA), "not-a-uuid", "get_status", {})).status).toBe(404);
    expect((await runByok(ctxOf(store, WA), "44444444-4444-4444-8444-444444444444", "get_status", {})).status).toBe(404); // no verified launch
    expect((await runByok(ctxOf(store, WA), SUSP, "get_status", {})).status).toBe(404);
    expect((await runByok(ctxOf(store, WA), PA, "delete_everything", {})).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it("rejects bad keys, unknown providers/models and missing idempotency", async () => {
    const { store } = spyStore();
    const base = { provider: "openai", apiKey: API_KEY, model: "gpt-4o-mini", idempotencyKey: "idem_aaaaaaaaaaaaaaaa", expectedRevision: 1 };
    for (const bad of [{ apiKey: "nope" }, { provider: "custom" }, { model: "gpt-5-ultra" }, { idempotencyKey: "x" }, { apiKey: API_KEY + "\nhttp://evil" }])
      expect((await runByok(ctxOf(store, WA), PA, "connect_or_replace", { ...base, ...bad })).status).toBe(400);
  });
});

// ---------- DB semantics (throwaway Postgres only) ----------
const URL_ = process.env["MCPX_TEST_PG_URL"];
const d = URL_ && /127\.0\.0\.1|localhost/.test(URL_) ? describe : describe.skip;
d("L7-A BYOK DB (throwaway Postgres)", () => {
  const conns: postgres.Sql[] = [];
  const wrap = (s: postgres.Sql): Db => ({ query: async (t, p) => ({ rows: (await s.unsafe(t, (p ?? []) as never[])) as never }) });
  let a: postgres.Sql; let A: Db; let store: ReturnType<typeof pgByokStore>;
  const idem = (n: number) => `idem_${String(n).padStart(16, "0")}`;
  const connect = (w: string, p: string, n: number, extra: Record<string, unknown> = {}) =>
    runByok(ctxOf(store, w), p, "connect_or_replace", { provider: "openai", apiKey: API_KEY, model: "gpt-4o-mini", idempotencyKey: idem(n), expectedRevision: 1, ...extra });

  beforeAll(async () => {
    a = postgres(URL_!, { max: 1, onnotice: () => {} }); conns.push(a); A = wrap(a); store = pgByokStore(A);
    await a.unsafe("drop schema if exists public cascade; create schema public; grant usage on schema public to public;");
    await a.unsafe("do $$ begin create role anon; exception when others then null; end $$; do $$ begin create role authenticated; exception when others then null; end $$; do $$ begin create role service_role; exception when others then null; end $$;");
    for (const f of ["drizzle/migrations/0000_mcpx_01b_registry_outbox.sql", "drizzle/migrations/0002_mcpx_03b_product_configs.sql", "drizzle/migrations/0014_mcpx_l7a_byok.sql", "drizzle/migrations/0015_mcpx_l7b_byok_health.sql"])
      await a.unsafe(readFileSync(f, "utf8").replace(/--> statement-breakpoint/g, ""));
    for (const [id, w, life, n] of [[PA, WA, "active", 1], [PB, WB, "inactive", 2]] as const) {
      await a.unsafe(`insert into public.mcp_creations (id, slug, template_id, template_version, display_name, ticker, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
        values ($1, $2, 'wallet-inspector', 1, 'P', 'P', $3, $4, 'So11111111111111111111111111111111111111112', 'solana-mainnet', $5, 1, now())`,
        [id, `prod-${n}`, w, `${"M".repeat(42)}${n}x`.slice(0, 44), `${"S".repeat(87)}${n}`]);
      await a.unsafe(`insert into public.mcp_product_configs (creation_id, template_id, template_version, lifecycle_state, activated_at) values ($1, 'wallet-inspector', '1.0.0', $2, case when $2 = 'active' then now() end)`, [id, life]);
    }
  });
  afterAll(async () => { for (const c of conns) await c.end(); });

  it("connect stores ciphertext only; status is redacted; replay is idempotent", async () => {
    const r = await connect(WA, PA, 1);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(API_KEY.slice(3, 20));
    expect((r.body["integration"] as any).hasKey).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("wxyz");
    const raw = await a.unsafe("select encode(ciphertext,'escape') c from public.mcpx_ai_credentials");
    expect(JSON.stringify(raw)).not.toContain(API_KEY.slice(3, 20));
    expect((await connect(WA, PA, 1)).body["result"]).toBe("replayed");
    // decrypts only via the backend keyring with the right binding
    const cred = (await store.loadActiveCredential(PA))!;
    expect(await open(await parseKeyring(`v1:${K1}`), cred.sealed, aadFor(PA, cred.idem))).toBe(API_KEY);
  });

  it("public roles cannot read tables or run functions", async () => {
    const r = await a.unsafe(`select bool_or(has_table_privilege(r, t, 'select')) tp,
        bool_or(has_function_privilege(r, 'public.mcpx_ai_admit(uuid,uuid,text,integer,integer)', 'execute')) fp
      from unnest(array['anon','authenticated']) r, unnest(array['public.mcpx_ai_integrations','public.mcpx_ai_credentials','public.mcpx_ai_usage','public.mcpx_ai_audit']) t`);
    expect(r[0]).toEqual({ tp: false, fp: false });
  });

  it("creator B cannot modify or revoke A's integration even through the store", async () => {
    expect(await store.revoke({ creationId: PA, wallet: WB, expectedRevision: null })).toBe("not_found");
    expect(await store.setEnabled({ creationId: PA, wallet: WB, enabled: true, expectedRevision: 1 })).toBe("not_found");
    expect((await store.getStatus(PA))!.status).toBe("configured");
  });

  it("admission: paused denies; atomic under concurrency; limits enforced; settle bounded", async () => {
    const cred = (await store.loadActiveCredential(PA))!;
    expect(await store.admit(PA, cred.credentialId, idem(100), 100, 100)).toBe("paused");
    const s0 = (await store.getStatus(PA))!;
    expect((await runByok(ctxOf(store, WA), PA, "set_enabled", { enabled: true, expectedRevision: s0.revision })).body).toEqual({ error: "needs_passing_test" });
    expect(await store.recordHealth({ creationId: PA, wallet: WA, credentialVersion: cred.version, health: "ok" })).toBe("ok");
    let s = (await store.getStatus(PA))!;
    expect((await runByok(ctxOf(store, WA), PA, "set_enabled", { enabled: true, expectedRevision: s.revision })).status).toBe(200);
    expect((await runByok(ctxOf(store, WA), PA, "set_enabled", { enabled: false, expectedRevision: s.revision })).status).toBe(409); // stale
    expect(await store.admit(PA, cred.credentialId, idem(101), 9000, 100)).toBe("too_large");
    // 8 concurrent callers on separate connections, max_concurrency = 1 → exactly one admitted
    const pool = await Promise.all(Array.from({ length: 8 }, async () => { const c = postgres(URL_!, { max: 1, onnotice: () => {} }); conns.push(c); return pgByokStore(wrap(c)); }));
    const res = await Promise.all(pool.map((p, i) => p.admit(PA, cred.credentialId, idem(200 + i), 100, 100)));
    expect(res.filter((x) => x.startsWith("admitted:")).length).toBe(1);
    expect(res.filter((x) => x === "busy").length).toBe(7);
    const usage = res.find((x) => x.startsWith("admitted:"))!.slice(9);
    expect(await store.settle(usage, "settled", 5000, 5000, 10)).toBe(true); // clamped to reservation
    expect(await store.settle(usage, "failed", 0, 0, 0)).toBe(false); // exactly once
    const u = await store.getUsage(PA);
    expect(u.today).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 100 });
    const won = res.findIndex((x) => x.startsWith("admitted:"));
    expect(await store.admit(PA, cred.credentialId, idem(200 + won), 100, 100)).toBe("duplicate");
  });

  it("stale reservations become ambiguous and are charged at the reserved amount", async () => {
    const cred = (await store.loadActiveCredential(PA))!;
    const r = await store.admit(PA, cred.credentialId, idem(300), 50, 60);
    await a.unsafe("update public.mcpx_ai_usage set lease_until = now() - interval '1 second' where id = $1", [r.slice(9)]);
    expect((await store.admit(PA, cred.credentialId, idem(301), 10, 10)).startsWith("admitted:")).toBe(true);
    const x = (await a.unsafe("select status, used_input, used_output from public.mcpx_ai_usage where id = $1", [r.slice(9)]))[0];
    expect(x).toEqual({ status: "ambiguous", used_input: 50, used_output: 60 });
  });

  it("rotate swaps credential; old credential can no longer be admitted", async () => {
    const before = (await store.loadActiveCredential(PA))!;
    const s = (await store.getStatus(PA))!;
    const r = await runByok(ctxOf(store, WA), PA, "rotate", { provider: "openai", apiKey: API_KEY, idempotencyKey: idem(2), expectedRevision: s.revision });
    expect(r.status).toBe(200);
    expect(await store.admit(PA, before.credentialId, idem(400), 10, 10)).toBe("credential_changed");
    const old = (await a.unsafe("select status, ciphertext from public.mcpx_ai_credentials where id = $1", [before.credentialId]))[0];
    expect(old).toEqual({ status: "retired", ciphertext: null });
  });

  it("revoke blocks admissions immediately; replayed or racing rotate cannot resurrect it", async () => {
    const cred = (await store.loadActiveCredential(PA))!;
    const s = (await store.getStatus(PA))!;
    const [rv, rt] = await Promise.all([
      runByok(ctxOf(store, WA), PA, "revoke_and_remove", {}),
      store.putCredential({ creationId: PA, wallet: WA, mode: "rotate", provider: "openai", sealed: cred.sealed, hint: "wxyz", model: "gpt-4o-mini", idem: idem(3), expectedRevision: s.revision }),
    ]);
    expect(rv.status).toBe(200);
    const final = (await store.getStatus(PA))!;
    // Either rotate ran first (then revoke shredded it) or rotate saw 'revoked'. Both end revoked with no active key.
    expect(["ok", "revoked", "stale_revision"]).toContain(rt);
    expect(final).toMatchObject({ status: "revoked", enabled: false, hasKey: false });
    expect(await store.loadActiveCredential(PA)).toBeNull();
    expect(await store.admit(PA, cred.credentialId, idem(500), 10, 10)).toBe("revoked");
    expect(await store.putCredential({ creationId: PA, wallet: WA, mode: "rotate", provider: "openai", sealed: cred.sealed, hint: "wxyz", model: "gpt-4o-mini", idem: idem(2), expectedRevision: final.revision })).not.toBe("ok");
    expect((await a.unsafe("select count(*)::int n from public.mcpx_ai_credentials where ciphertext is not null"))[0]!["n"]).toBe(0);
    // explicit reconnect opens a fresh, paused configuration
    expect((await connect(WA, PA, 9)).status).toBe(200);
    expect((await store.getStatus(PA))!).toMatchObject({ status: "configured", enabled: false });
  });

  it("an unlaunched (inactive) product can be configured but never admitted", async () => {
    expect((await connect(WB, PB, 20)).status).toBe(200);
    await store.recordHealth({ creationId: PB, wallet: WB, credentialVersion: (await store.loadActiveCredential(PB))!.version, health: "ok" });
    const s = (await store.getStatus(PB))!;
    await runByok(ctxOf(store, WB), PB, "set_enabled", { enabled: true, expectedRevision: s.revision });
    const cred = (await store.loadActiveCredential(PB))!;
    expect(await store.admit(PB, cred.credentialId, idem(600), 10, 10)).toBe("product_inactive");
  });

  it("audit trail has actions but no secret material", async () => {
    const rows = await a.unsafe("select * from public.mcpx_ai_audit order by id");
    expect(rows.map((r) => r["action"])).toEqual(expect.arrayContaining(["connect", "enable", "rotate", "revoke"]));
    expect(JSON.stringify(rows)).not.toContain(API_KEY.slice(3, 20));
  });
});

describe("L7-A isolation", () => {
  it("the BYOK route is on by default with only an emergency stop and no source file contains a key-like literal", () => {
    expect(readFileSync("src/routes/api/creator/ai.ts", "utf8")).toContain(`process.env["MCPX_BYOK_DISABLED"] === "1"`);
    expect(readFileSync("src/routes/api/creator/ai.ts", "utf8")).not.toContain("MCPX_BYOK_ENABLED");
    expect(readdirSync("src/routes/api/public").join(",")).not.toMatch(/byok|ai\.ts/);
    for (const f of readdirSync("src/lib/byok")) expect(readFileSync(`src/lib/byok/${f}`, "utf8")).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });
});
