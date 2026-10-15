// Server-only helpers shared by every tool relay route. Only called inside server route handlers;
// process.env and the admin client are read lazily inside functions, never at module scope.
export const LIMITS = { perVisitorPerMinute: 6, perVisitorPerHour: 40, globalPerMinute: 60 };
// One budget for ALL tools: adding a tool must never multiply visitor or global capacity.
export const SHARED_BUCKET_PREFIX = "tools";
const READY_TIMEOUT_MS = 4_000;
const WORKER_TIMEOUT_MS = 25_000;
export const MAX_RESPONSE_BYTES = 1_500_000;
/** Free website test runs per visitor, per tool, per UTC day. MCP calls (bearer keys) do not use this allowance. */
// mcpx_free_test_take accepts limits up to 1000 (migration 0035).
export const FREE_TESTS_PER_DAY = 500;
export const freeTestBucket = (toolId: string, visitor: string) => ({ bucket: `${SHARED_BUCKET_PREFIX}:free:${toolId}:${visitor}`, window: 86_400, limit: FREE_TESTS_PER_DAY });

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function workerConfig() {
  const url = process.env["MCPX_WORKER_URL"]?.replace(/\/+$/, "");
  const secret = process.env["MCPX_WORKER_SECRET"];
  return url && url.startsWith("https://") && secret && secret.length >= 32 ? { url, secret } : null;
}
type Cfg = NonNullable<ReturnType<typeof workerConfig>>;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

/** Bucket names for a visitor. Pure, so the "shared across tools" rule is testable. */
export function bucketsFor(visitor: string) {
  return [
    { bucket: `${SHARED_BUCKET_PREFIX}:m:${visitor}`, window: 60, limit: LIMITS.perVisitorPerMinute },
    { bucket: `${SHARED_BUCKET_PREFIX}:h:${visitor}`, window: 3600, limit: LIMITS.perVisitorPerHour },
    { bucket: `${SHARED_BUCKET_PREFIX}:global`, window: 60, limit: LIMITS.globalPerMinute },
  ];
}

/**
 * Visitor key: HMAC of the client IP. Trust assumption: on the published site, cf-connecting-ip is set
 * by the edge and cannot be spoofed by the browser; x-forwarded-for is only a fallback and is spoofable,
 * which is why the global bucket also applies to everyone.
 * Returns "ok", "limited", or "unavailable" (fail closed).
 */
export async function takeShared(cfg: Cfg, request: Request, freeTestToolId?: string): Promise<"ok" | "limited" | "free_limit" | "unavailable"> {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const visitor = (await hmac(cfg.secret, `ip:${ip}`)).slice(0, 32); // raw IP never stored
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    for (const b of bucketsFor(visitor)) {
      const { data, error } = await supabaseAdmin.rpc("mcpx_rate_limit_take", { _bucket: b.bucket, _window_seconds: b.window, _limit: b.limit });
      if (error) return "unavailable";
      if (data !== true) return "limited";
    }
    if (freeTestToolId) {
      // Taken last so a run blocked by the shared limits does not use up a free test.
      const f = freeTestBucket(freeTestToolId, visitor);
      const { data, error } = await supabaseAdmin.rpc("mcpx_free_test_take", { _bucket: f.bucket, _limit: f.limit }); // per-UTC-day counter, resets 00:00 UTC
      if (error) return "unavailable";
      if (data !== true) return "free_limit";
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

/** Is the worker ready AND does it advertise this tool? */
export async function toolAvailability(toolId: string) {
  const cfg = workerConfig();
  if (!cfg) return { available: false, reason: "not_configured" };
  try {
    const r = await fetch(`${cfg.url}/ready`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    if (!r.ok) return { available: false, reason: "worker_not_ready" };
    const b = (await r.json().catch(() => null)) as { tools?: unknown } | null;
    const tools = Array.isArray(b?.tools) ? b!.tools : [];
    return tools.includes(toolId) ? { available: true, limits: LIMITS } : { available: false, reason: "tool_not_deployed" };
  } catch {
    return { available: false, reason: "worker_unreachable" };
  }
}

/** Signs and sends one execution; returns parsed JSON or a safe error kind. */
export async function callWorker(cfg: Cfg, payload: string, request: Request): Promise<{ ok: true; out: unknown } | { ok: false; status: number; error: string }> {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const sig = await hmac(cfg.secret, `${ts}.${nonce}.${payload}`);
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/internal/v1/tools/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcpx-timestamp": ts, "x-mcpx-nonce": nonce, "x-mcpx-signature": sig },
      body: payload,
      signal: AbortSignal.any([AbortSignal.timeout(WORKER_TIMEOUT_MS), request.signal]),
    });
  } catch {
    return { ok: false, status: 504, error: "timeout" };
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) return { ok: false, status: 502, error: "too_large" };
  let out: unknown;
  try { out = JSON.parse(text); } catch { return { ok: false, status: 502, error: "bad_response" }; }
  if (!res.ok) {
    const k = (out as { error?: unknown })?.error;
    const allowed = ["rate_limited", "busy", "timeout", "provider_error", "too_large", "bad_response", "invalid_input", "unsupported_version"];
    return { ok: false, status: res.status === 429 ? 429 : 502, error: typeof k === "string" && allowed.includes(k) ? k : "provider_error" };
  }
  return { ok: true, out };
}

/** Strict small JSON body with exactly one string field. */
export async function readSingleField(request: Request, field: string, maxBody: number): Promise<string | Response> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
  const raw = await request.text();
  if (raw.length > maxBody) return json(413, { error: "invalid_input" });
  let b: unknown;
  try { b = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
  const o = b as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).join(",") !== field || typeof o[field] !== "string") return json(400, { error: "invalid_input" });
  return o[field] as string;
}
