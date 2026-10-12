// Public, read-only token artwork and metadata. Serves only paths recorded as validated artifacts,
// with the recorded content type, an integrity check, and headers that stop any content from executing.
import { createFileRoute } from "@tanstack/react-router";

const PATH_RE = /^(artwork\/[0-9a-f-]{36}\.(png|jpg|webp)|metadata\/[0-9a-f-]{36}\.json)$/;

export const Route = createFileRoute("/api/public/launch-assets/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const path = (params as { _splat?: string })._splat ?? "";
        const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "access-control-allow-origin": "*" };
        if (!PATH_RE.test(path)) return new Response("Not found", { status: 404, headers: { ...base, "content-type": "text/plain" } });
        try {
          const { readArtifact } = await import("@/lib/launch/drafts.server");
          const a = await readArtifact(path);
          if (!a) return new Response("Not found", { status: 404, headers: { ...base, "content-type": "text/plain", "cache-control": "no-store" } });
          return new Response(a.bytes as unknown as BodyInit, { status: 200, headers: { ...base, "content-type": a.contentType, "cache-control": "public, max-age=31536000, immutable", etag: `"${a.sha256}"` } });
        } catch {
          return new Response("Unavailable", { status: 503, headers: { ...base, "content-type": "text/plain", "cache-control": "no-store" } });
        }
      },
    },
  },
});
