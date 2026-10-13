// Rewards worker ⇄ site bridge (Option 1). The Render worker holds NO database credentials: it sends sealed
// (HMAC-SHA256) statement batches to /api/public/rewards/*; the site verifies the seal, checks freshness + single-use
// nonce, validates every statement, and executes the batch in ONE database transaction. WebCrypto only (Node + workerd).
import type { Db, Step } from "./store.pg";

export const SEAL_MAX_SKEW_SECONDS = 300;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_STEPS = 20_000;
export const MAX_SQL_CHARS = 4000;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
export const sealMessage = (method: string, path: string, ts: string, nonce: string, bodyHash: string) => `mcpx-rw-v1\n${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;

export async function seal(secret: string, method: string, path: string, body: string, nowSec = Math.floor(Date.now() / 1000), nonce = crypto.randomUUID()) {
  const ts = String(nowSec);
  const sig = await hmacHex(secret, sealMessage(method, path, ts, nonce, await sha256Hex(body)));
  return { "x-mcpx-rw-ts": ts, "x-mcpx-rw-nonce": nonce, "x-mcpx-rw-sig": sig };
}

function safeEq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

/** Verifies seal + freshness. Nonce single-use is checked separately (needs storage). */
export async function verifySeal(secret: string, method: string, path: string, body: string, h: { ts: string | null; nonce: string | null; sig: string | null }, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) return { ok: false as const, reason: "SECRET_UNSET" };
  if (!h.ts || !h.nonce || !h.sig || !/^\d{9,11}$/.test(h.ts) || !/^[A-Za-z0-9-]{16,64}$/.test(h.nonce) || !/^[0-9a-f]{64}$/.test(h.sig)) return { ok: false as const, reason: "MALFORMED" };
  if (Math.abs(nowSec - Number(h.ts)) > SEAL_MAX_SKEW_SECONDS) return { ok: false as const, reason: "STALE" };
  const want = await hmacHex(secret, sealMessage(method, path, h.ts, h.nonce, await sha256Hex(body)));
  return safeEq(want, h.sig) ? { ok: true as const } : { ok: false as const, reason: "BAD_SEAL" };
}

// ---- statement guard + literal binding (site side) ----
const DENY = /(;|--|\/\*|\$\$|\bpg_|information_schema|\bcurrent_setting\b|\bset_config\b|\bdblink|\blo_|\bcopy\b|\bexecute\b|\bgrant\b|\brevoke\b|\balter\b|\bdrop\b|\bcreate\b|\btruncate\b|\bauth\.|\bstorage\.|\bvault\b|\bsupabase_|\brealtime\.)/i;
/** Only DML/selects that touch public.mcpx_rw_* (the DB function also pins search_path so unqualified names reach nothing). */
export function guardSql(sql: string): string | null {
  if (typeof sql !== "string" || !sql.length || sql.length > MAX_SQL_CHARS) return "SQL_SIZE";
  if (!/^\s*(select|insert|update|delete|with)\s/i.test(sql)) return "SQL_KIND";
  if (DENY.test(sql)) return "SQL_DENIED";
  for (const m of sql.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)/gi)) if (!m[1]!.toLowerCase().startsWith("mcpx_rw_")) return "SQL_RELATION";
  if (/\bpublic\s*\.\s*"/i.test(sql)) return "SQL_RELATION";
  return null;
}
function pgArray(xs: unknown[]): string {
  return "{" + xs.map((x) => (x === null || x === undefined ? "NULL" : `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",") + "}";
}
export function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = Array.isArray(v) ? pgArray(v) : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  if (s.includes("\u0000")) throw new Error("NUL_IN_PARAM");
  return "'" + s.replace(/'/g, "''") + "'"; // standard_conforming_strings=on: backslashes are literal
}
/** Single pass $n substitution (replacement output is never rescanned). */
export function bind(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, k) => { const i = Number(k) - 1; if (i < 0 || i >= params.length) throw new Error("PARAM_INDEX"); return literal(params[i]); });
}
export const returnsRows = (sql: string) => /^\s*(select|with)\s/i.test(sql) || /\breturning\b/i.test(sql);

export type WireStep = { sql: string; params?: unknown[]; abortIfEmpty?: string };
/** Validates + binds a batch → DB payload. Throws with a code on any rejection. */
export function prepareBatch(steps: unknown): { q: string; r: boolean; a: string | null }[] {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw new Error("BATCH_SIZE");
  return steps.map((st: any) => {
    if (!st || typeof st !== "object") throw new Error("STEP_SHAPE");
    const g = guardSql(st.sql); if (g) throw new Error(g);
    const params = st.params ?? [];
    if (!Array.isArray(params) || params.length > 32) throw new Error("PARAMS");
    for (const p of params) if (p !== null && !["string", "number", "boolean"].includes(typeof p) && !(Array.isArray(p) && p.length <= 5000 && p.every((x) => x === null || ["string", "number"].includes(typeof x)))) throw new Error("PARAM_TYPE");
    const a = st.abortIfEmpty === undefined ? null : String(st.abortIfEmpty);
    if (a !== null && !/^[A-Z_]{1,32}$/.test(a)) throw new Error("ABORT_CODE");
    const q = bind(st.sql, params);
    return { q, r: returnsRows(st.sql), a };
  });
}

// ---- worker side ----
const wire = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Date ? x.toISOString() : x));
export type RemoteConfig = { siteUrl: string; secret: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export async function sealedPost(c: RemoteConfig, path: string, payload: unknown) {
  const body = wire(payload);
  const headers = { "content-type": "application/json", ...(await seal(c.secret, "POST", path, body)) };
  const r = await (c.fetchImpl ?? fetch)(c.siteUrl.replace(/\/$/, "") + path, { method: "POST", headers, body, signal: AbortSignal.timeout(c.timeoutMs ?? 120_000) });
  const j = (await r.json().catch(() => null)) as any;
  if (!r.ok || !j || j.ok !== true) throw new Error(`site_${path.split("/").pop()}_${r.status}_${j?.error ?? "unknown"}`);
  return j;
}

/** Db implementation for the worker: every statement/batch goes through the sealed site endpoint. */
export function remoteDb(c: RemoteConfig): Db {
  return {
    async query(sql, params) {
      if (/^\s*(begin|commit|rollback)\b/i.test(sql)) throw new Error("use_runTx_for_transactions");
      const j = await sealedPost(c, "/api/public/rewards/exec", { steps: [{ sql, params: params ?? [] }] });
      return { rows: j.results[0]?.rows ?? [] };
    },
    async tx(steps: Step[]) {
      const j = await sealedPost(c, "/api/public/rewards/exec", { steps });
      return { aborted: j.aborted ?? null };
    },
  };
}
