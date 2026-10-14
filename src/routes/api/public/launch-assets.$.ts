// Public, read-only token artwork and metadata. Serves only paths recorded as validated artifacts,
// with the recorded content type, an integrity check, and headers that stop any content from executing.
import { createFileRoute } from "@tanstack/react-router";

const PATH_RE = /^(artwork\/[0-9a-f-]{36}\.(png|jpg|webp)|metadata\/[0-9a-f-]{36}\.json)$/;

type Artifact = { bytes: Uint8Array; contentType: string; sha256: string };
const MEM = new Map<string, Artifact>(); // per-isolate, bounded
const ok = (a: Artifact, base: Record<string, string>) => new Response(a.bytes as unknown as BodyInit, { status: 200, headers: { ...base, "content-type": a.contentType, "cache-control": "public, max-age=31536000, immutable", etag: `"${a.sha256}"` } });

export const Route = createFileRoute("/api/public/launch-assets/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const path = (params as { _splat?: string })._splat ?? "";
        const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "access-control-allow-origin": "*" };
        if (!PATH_RE.test(path)) return new Response("Not found", { status: 404, headers: { ...base, "content-type": "text/plain" } });
        // Artifacts are immutable, so a burst after a launch (indexers, Pump.fun, bots) is served from memory or the
        // edge cache so the database and storage are only read on a miss (promises are never shared across requests on workerd).
        const hit = MEM.get(path);
        if (hit) return ok(hit, base);
        const edge = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
        const cacheKey = new Request(`https://mcpx-asset-cache.internal/${path}`);
        try {
          const cached = edge ? await edge.match(cacheKey).catch(() => undefined) : undefined;
          if (cached) return cached;
          const a = await (await import("@/lib/launch/drafts.server")).readArtifact(path);
          if (!a) return new Response("Not found", { status: 404, headers: { ...base, "content-type": "text/plain", "cache-control": "no-store" } });
          if (a.bytes.byteLength <= 512 * 1024) { if (MEM.size >= 200) MEM.delete(MEM.keys().next().value!); MEM.set(path, a); }
          const res = ok(a, base);
          if (edge) await edge.put(cacheKey, res.clone()).catch(() => {});
          return res;
        } catch {
          return new Response("Unavailable", { status: 503, headers: { ...base, "content-type": "text/plain", "cache-control": "no-store" } });
        }
      },
    },
  },
});
