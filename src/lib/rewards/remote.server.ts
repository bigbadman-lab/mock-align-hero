// Site side of the rewards bridge. Sealed-request check shared by /api/public/rewards/* handlers.
import { MAX_BODY_BYTES, verifySeal } from "./remote";

const deny = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });

/** Returns the verified raw body, or a Response to send back. Nothing is read or written before this passes. */
export async function checkSealed(request: Request, path: string): Promise<{ body: string } | Response> {
  const secret = process.env["MCPX_REWARDS_SHARED_SECRET"] ?? "";
  if (!secret) return deny(503, "BRIDGE_NOT_CONFIGURED");
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return deny(413, "TOO_LARGE");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return deny(413, "TOO_LARGE");
  const h = { ts: request.headers.get("x-mcpx-rw-ts"), nonce: request.headers.get("x-mcpx-rw-nonce"), sig: request.headers.get("x-mcpx-rw-sig") };
  const v = await verifySeal(secret, "POST", path, body, h);
  if (!v.ok) return deny(401, "UNAUTHORIZED"); // one answer for every seal failure
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any).rpc("mcpx_rw_remote_nonce_take", { p_nonce: h.nonce });
  if (error) return deny(503, "NONCE_STORE_UNAVAILABLE");
  if (data !== true) return deny(401, "UNAUTHORIZED");
  return { body };
}

export const okJson = (o: Record<string, unknown>) => Response.json({ ok: true, ...o }, { headers: { "cache-control": "no-store" } });
export { deny };
