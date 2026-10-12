// Shared HTTP helpers for creator-auth routes (server-only).
import { MAX_AUTH_BODY, checkMutation } from "./core";

export const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

const STATUS: Record<string, number> = { method_not_allowed: 405, forbidden: 403, unsupported_media_type: 415, too_large: 413 };

/** CSRF/shape check + bounded JSON object body with exactly the given keys. */
export async function readMutation(request: Request, keys: string[]): Promise<Record<string, unknown> | Response> {
  const bad = checkMutation(request);
  if (bad) return reply(STATUS[bad] ?? 400, { error: bad });
  const raw = await request.text();
  if (raw.length > MAX_AUTH_BODY) return reply(413, { error: "too_large" });
  let b: unknown;
  try { b = JSON.parse(raw); } catch { return reply(400, { error: "invalid_input" }); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { error: "invalid_input" });
  const o = b as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== [...keys].sort().join(",")) return reply(400, { error: "invalid_input" });
  return o;
}
export const hostOf = (request: Request) => request.headers.get("host") ?? "";
