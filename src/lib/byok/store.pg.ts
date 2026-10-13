// Postgres ByokStore (server-only; service role). All state transitions go through the 0014 SQL functions or
// revision-guarded UPDATEs; reads never select iv/ciphertext except loadActiveCredential (L7-B runtime only).
import type { Db } from "@/lib/rewards/store.pg";
import type { ByokStatus, ByokStore, ByokUsage } from "./core";
import type { Sealed } from "./crypto";

/** Shared row → status mapping (pg and service-role stores). Never includes key material. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToStatus(x: any): ByokStatus {
  return { provider: x.provider, model: x.model, status: x.status, enabled: x.enabled, revision: x.revision,
    hasKey: x.version !== null && x.version !== undefined, credentialVersion: x.version ?? null, updatedAt: new Date(x.updated_at).toISOString(),
    health: x.health ?? "unchecked", healthCredentialVersion: x.health_credential_version ?? null,
    healthCheckedAt: x.health_checked_at ? new Date(x.health_checked_at).toISOString() : null,
    limits: { maxConcurrency: x.max_concurrency, maxPerMinute: x.max_per_minute, maxPerDay: x.max_per_day, maxInputTokens: x.max_input_tokens, maxOutputTokens: x.max_output_tokens } };
}

const bytes = (b: unknown) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) : null);

export function pgByokStore(db: Db): ByokStore & {
  admit(creationId: string, credentialId: string, ref: string, inTok: number, outTok: number): Promise<string>;
  settle(usageId: string, status: "settled" | "failed" | "ambiguous", inTok: number | null, outTok: number | null, costMicros: number | null): Promise<boolean>;
  loadActiveCredential(creationId: string): Promise<{ credentialId: string; version: number; idem: string; sealed: Sealed } | null>;
  purgeUsage(batch: number): Promise<number>;
} {
  return {
    async putCredential(p) {
      const r = await db.query("SELECT public.mcpx_ai_put_credential($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r",
        [p.creationId, p.wallet, p.mode, p.provider, p.sealed.iv, p.sealed.ciphertext, p.sealed.kekVersion, p.hint, p.model, p.idem, p.expectedRevision]);
      return r.rows[0].r;
    },
    async revoke(p) {
      return (await db.query("SELECT public.mcpx_ai_revoke($1,$2,$3) AS r", [p.creationId, p.wallet, p.expectedRevision])).rows[0].r;
    },
    async setEnabled(p) {
      return (await db.query("SELECT public.mcpx_ai_set_enabled($1,$2,$3,$4) AS r", [p.creationId, p.wallet, p.enabled, p.expectedRevision])).rows[0].r;
    },
    async setModelAndLimits(p) {
      const l = p.limits;
      return (await db.query("SELECT public.mcpx_ai_set_model_limits($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r",
        [p.creationId, p.wallet, p.model, l.maxConcurrency, l.maxPerMinute, l.maxPerDay, l.maxInputTokens, l.maxOutputTokens, p.expectedRevision])).rows[0].r;
    },
    async recordHealth(p) {
      return (await db.query("SELECT public.mcpx_ai_record_health($1,$2,$3,$4) AS r", [p.creationId, p.wallet, p.credentialVersion, p.health])).rows[0].r;
    },
    async purgeUsage(batch: number): Promise<number> {
      return Number((await db.query("SELECT public.mcpx_ai_purge_usage($1) AS r", [batch])).rows[0].r);
    },
    async getStatus(creationId): Promise<ByokStatus | null> {
      const r = await db.query(
        `SELECT i.provider, i.model, i.status, i.enabled, i.revision, i.updated_at, i.max_concurrency, i.max_per_minute, i.max_per_day,
                i.max_input_tokens, i.max_output_tokens, i.health, i.health_credential_version, i.health_checked_at, c.version
           FROM public.mcpx_ai_integrations i LEFT JOIN public.mcpx_ai_credentials c ON c.integration_id = i.id AND c.status = 'active'
          WHERE i.creation_id = $1`, [creationId]);
      const x = r.rows[0];
      if (!x) return null;
      return rowToStatus(x);
    },
    async getUsage(creationId): Promise<ByokUsage> {
      const r = await db.query(
        `SELECT count(*)::int AS n, COALESCE(sum(used_input),0)::int AS i, COALESCE(sum(used_output),0)::int AS o, COALESCE(sum(est_cost_micros),0)::bigint AS c,
                count(*) FILTER (WHERE u.status = 'failed')::int AS f, count(*) FILTER (WHERE u.status = 'ambiguous')::int AS a,
                count(*) FILTER (WHERE u.status = 'reserved')::int AS r
           FROM public.mcpx_ai_usage u JOIN public.mcpx_ai_integrations i ON i.id = u.integration_id
          WHERE i.creation_id = $1 AND u.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [creationId]);
      const x = r.rows[0];
      return { today: { requests: x.n, inputTokens: x.i, outputTokens: x.o, estCostMicros: Number(x.c), failed: x.f, ambiguous: x.a }, inFlight: x.r };
    },
    async admit(creationId, credentialId, ref, inTok, outTok) {
      return (await db.query("SELECT public.mcpx_ai_admit($1,$2,$3,$4,$5) AS r", [creationId, credentialId, ref, inTok, outTok])).rows[0].r;
    },
    async settle(usageId, status, inTok, outTok, cost) {
      return (await db.query("SELECT public.mcpx_ai_settle($1,$2,$3,$4,$5) AS r", [usageId, status, inTok, outTok, cost])).rows[0].r;
    },
    async loadActiveCredential(creationId) {
      const r = await db.query(
        `SELECT c.id, c.version, c.idempotency_key, c.iv, c.ciphertext, c.kek_version, c.alg FROM public.mcpx_ai_credentials c
           JOIN public.mcpx_ai_integrations i ON i.id = c.integration_id
          WHERE i.creation_id = $1 AND c.status = 'active' AND i.status = 'configured'`, [creationId]);
      const x = r.rows[0];
      const iv = bytes(x?.iv), ct = bytes(x?.ciphertext);
      if (!x || !iv || !ct) return null;
      return { credentialId: x.id, version: x.version, idem: x.idempotency_key, sealed: { iv, ciphertext: ct, kekVersion: x.kek_version, alg: x.alg } };
    },
  };
}

async function whyNot(db: Db, creationId: string, wallet: string) {
  const r = await db.query("SELECT status, creator_wallet FROM public.mcpx_ai_integrations WHERE creation_id = $1", [creationId]);
  const x = r.rows[0];
  if (!x || x.creator_wallet !== wallet) return "not_found";
  return x.status === "revoked" ? "revoked" : "stale_revision";
}
