// Artwork upload (cookie session). Raw image body, bounded at 5,000,000 bytes before and while reading;
// validated on the server by file signature and structure; declared type must match the real one.
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { UUID_RE } from "@/lib/launch/drafts-core";
import { IMAGE_MAX_BYTES, checkImage } from "@/lib/launch/image";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const STATUS: Record<string, number> = { method_not_allowed: 405, forbidden: 403, unsupported_media_type: 415, too_large: 413 };
const CONFLICT: Record<string, number> = { not_found: 404, stale_revision: 409, storage_limit: 409, uri_too_long: 409 };

async function readBounded(request: Request): Promise<Uint8Array | null> {
  const r = request.body?.getReader();
  if (!r) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.byteLength;
    if (n > IMAGE_MAX_BYTES) { await r.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const Route = createFileRoute("/api/creator/launch-artwork")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: IMAGE_MAX_BYTES, contentTypes: TYPES });
        if (bad) return reply(STATUS[bad] ?? 400, { error: bad });
        if (!request.headers.get("content-length")) return reply(411, { error: "length_required" });
        const q = new URL(request.url).searchParams;
        const id = q.get("draft") ?? "", revision = Number(q.get("revision"));
        if (!UUID_RE.test(id) || !Number.isInteger(revision) || revision < 1 || [...q.keys()].length !== 2) return reply(400, { error: "invalid_input" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          const m = await import("@/lib/launch/drafts.server");
          if (!(await m.takeLaunchBudget(s.wallet, "upload"))) return reply(429, { error: "rate_limited" });
          const bytes = await readBounded(request);
          if (!bytes) return reply(413, { error: "too_large" });
          const checked = await checkImage(bytes);
          if (!checked.ok) return reply(422, { error: "invalid_image", message: checked.error });
          const img = await (await import("@/lib/launch/decode.server")).decodeArtwork(bytes, checked);
          if (!img.ok) return reply(422, { error: "invalid_image", message: img.error });
          const declared = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
          if (declared !== img.type) return reply(422, { error: "invalid_image", message: "The file's contents don't match its type." });
          try {
            return reply(200, { draft: await m.saveArtwork(s.wallet, `https://${request.headers.get("host")}`, id, revision, bytes, img) });
          } catch (e) {
            if (e instanceof m.Conflict) return reply(CONFLICT[e.code] ?? 409, { error: e.code });
            throw e;
          }
        } catch { return reply(503, { error: "unavailable" }); }
      },
    },
  },
});
