// Production ByokStore over the website server's service-role client (no browser path). All state changes go
// through the 0014/0015 SQL functions, which lock the integration row; reads never select iv/ciphertext except
// loadActiveCredential (used only by test_connection, server-side).
import type { ByokStore, ByokUsage } from "./core";
import { rowToStatus } from "./store.pg";

// The service-role client's generated types lag pending columns/functions; keep the escape hatch local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin = async (): Promise<any> => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
const must = <T,>(r: { data: T; error: unknown }): T => { if (r.error) throw new Error("byok_store_unavailable"); return r.data; };
const toHex = (b: Uint8Array) => "\\x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: unknown): Uint8Array<ArrayBuffer> | null => {
  if (typeof s !== "string" || !/^\\x([0-9a-f]{2})+$/i.test(s)) return null;
  const h = s.slice(2), out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const rpc = async (fn: string, args: Record<string, unknown>) => must(await (await admin()).rpc(fn, args)) as string;

async function integration(creationId: string) {
  const db = await admin();
  return must(await db.from("mcpx_ai_integrations")
    .select("id, provider, model, status, enabled, revision, updated_at, max_concurrency, max_per_minute, max_per_day, max_input_tokens, max_output_tokens, health, health_credential_version, health_checked_at")
    .eq("creation_id", creationId).maybeSingle()) as Record<string, unknown> | null;
}

export const serviceByokStore: ByokStore & {
  purgeUsage(batch: number): Promise<number>;
  admit(creationId: string, credentialId: string, ref: string, inTok: number, outTok: number): Promise<string>;
  settle(usageId: string, status: "settled" | "failed" | "ambiguous", inTok: number | null, outTok: number | null, costMicros: number | null): Promise<boolean>;
} = {
  admit: (creationId, credentialId, ref, inTok, outTok) => rpc("mcpx_ai_admit", { _creation: creationId, _credential: credentialId, _ref: ref, _in: inTok, _out: outTok }),
  settle: async (usageId, status, inTok, outTok, cost) => Boolean(await rpc("mcpx_ai_settle", { _usage: usageId, _status: status, _in: inTok, _out: outTok, _cost: cost })),
  putCredential: (p) => rpc("mcpx_ai_put_credential", { _creation: p.creationId, _wallet: p.wallet, _mode: p.mode, _provider: p.provider,
    _iv: toHex(p.sealed.iv), _ct: toHex(p.sealed.ciphertext), _kek: p.sealed.kekVersion, _hint: p.hint, _model: p.model, _idem: p.idem, _expected_rev: p.expectedRevision }),
  revoke: (p) => rpc("mcpx_ai_revoke", { _creation: p.creationId, _wallet: p.wallet, _expected_rev: p.expectedRevision }),
  setEnabled: (p) => rpc("mcpx_ai_set_enabled", { _creation: p.creationId, _wallet: p.wallet, _enabled: p.enabled, _expected_rev: p.expectedRevision }),
  setModelAndLimits: (p) => rpc("mcpx_ai_set_model_limits", { _creation: p.creationId, _wallet: p.wallet, _model: p.model, _conc: p.limits.maxConcurrency,
    _pm: p.limits.maxPerMinute, _pd: p.limits.maxPerDay, _in: p.limits.maxInputTokens, _out: p.limits.maxOutputTokens, _expected_rev: p.expectedRevision }),
  recordHealth: (p) => rpc("mcpx_ai_record_health", { _creation: p.creationId, _wallet: p.wallet, _cred_version: p.credentialVersion, _health: p.health }),
  async getStatus(creationId) {
    const i = await integration(creationId);
    if (!i) return null;
    const db = await admin();
    const c = must(await db.from("mcpx_ai_credentials").select("version").eq("integration_id", i["id"]).eq("status", "active").maybeSingle()) as { version: number } | null;
    return rowToStatus({ ...i, version: c?.version ?? null });
  },
  async getUsage(creationId): Promise<ByokUsage> {
    const empty = { today: { requests: 0, inputTokens: 0, outputTokens: 0, estCostMicros: 0, failed: 0, ambiguous: 0 }, inFlight: 0 };
    const i = await integration(creationId);
    if (!i) return empty;
    const db = await admin();
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    // Bounded: per-day cap is ≤2000 by CHECK, so 2500 rows covers a full UTC day.
    const rows = must(await db.from("mcpx_ai_usage").select("status, used_input, used_output, est_cost_micros")
      .eq("integration_id", i["id"]).gte("created_at", dayStart).limit(2500)) as { status: string; used_input: number | null; used_output: number | null; est_cost_micros: number | null }[];
    const u = empty;
    for (const r of rows) {
      u.today.requests++; u.today.inputTokens += r.used_input ?? 0; u.today.outputTokens += r.used_output ?? 0; u.today.estCostMicros += Number(r.est_cost_micros ?? 0);
      if (r.status === "failed") u.today.failed++;
      if (r.status === "ambiguous") u.today.ambiguous++;
      if (r.status === "reserved") u.inFlight++;
    }
    return u;
  },
  async loadActiveCredential(creationId) {
    const i = await integration(creationId);
    if (!i || i["status"] !== "configured") return null;
    const db = await admin();
    const c = must(await db.from("mcpx_ai_credentials").select("id, version, idempotency_key, iv, ciphertext, kek_version, alg")
      .eq("integration_id", i["id"]).eq("status", "active").maybeSingle()) as Record<string, unknown> | null;
    const iv = fromHex(c?.["iv"]), ct = fromHex(c?.["ciphertext"]);
    if (!c || !iv || !ct) return null;
    return { credentialId: c["id"] as string, version: c["version"] as number, idem: c["idempotency_key"] as string, sealed: { iv, ciphertext: ct, kekVersion: c["kek_version"] as string, alg: c["alg"] as never } };
  },
  async purgeUsage(batch) { return Number(await rpc("mcpx_ai_purge_usage", { _batch: batch })); },
};

/** Per-product + global budget for live OpenAI connection tests (shared rate-limit table, service role only). */
export async function takeByokTestBudget(creationId: string): Promise<boolean> {
  try {
    const db = await admin();
    for (const [bucket, window, limit] of [[`byok-test:m:${creationId}`, 60, 2], [`byok-test:h:${creationId}`, 3600, 10], ["byok-test:global", 60, 30]] as const) {
      const { data, error } = await db.rpc("mcpx_rate_limit_take", { _bucket: bucket, _window_seconds: window, _limit: limit });
      if (error || data !== true) return false;
    }
    return true;
  } catch { return false; }
}

/** Production AI execution deps for product MCP endpoints. Missing/invalid keyring → AI simply not available. */
export async function productionAiDeps(): Promise<import("./execute").AiDeps | null> {
  if (process.env["MCPX_BYOK_DISABLED"] === "1") return null; // emergency stop only; default is on
  const { parseKeyring } = await import("./crypto");
  const raw = process.env["MCPX_BYOK_KEYRING"];
  try { await parseKeyring(raw); } catch { return null; }
  return {
    getStatus: serviceByokStore.getStatus, loadActiveCredential: serviceByokStore.loadActiveCredential,
    admit: serviceByokStore.admit, settle: serviceByokStore.settle, recordHealth: serviceByokStore.recordHealth,
    keyring: () => parseKeyring(raw),
    async creatorWallet(creationId) {
      const db = await admin();
      const c = must(await db.from("mcp_creations").select("creator_wallet").eq("id", creationId).maybeSingle()) as { creator_wallet: string } | null;
      return c?.creator_wallet ?? null;
    },
  };
}
