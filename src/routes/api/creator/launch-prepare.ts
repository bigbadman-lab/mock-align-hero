// Child launch preparation (creator cookie session + CSRF). Disabled unless MCPX_CHILD_LAUNCH_ENABLED=1.
// POST { op: "prepare", ... } builds an unsigned candidate bound to the session wallet;
// POST { op: "verify", ... } re-checks it immediately before the wallet signs. Never signs or sends.
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { gatePrepare, gateVerify } from "@/lib/tx-builder/launch-gate";
import { builderCall, gateConfig } from "@/lib/tx-builder/client.server";

const STATUS: Record<string, number> = { method_not_allowed: 405, forbidden: 403, unsupported_media_type: 415, too_large: 413 };

export const Route = createFileRoute("/api/creator/launch-prepare")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { ok: false, code: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: 64_000 });
        if (bad) return reply(STATUS[bad] ?? 400, { ok: false, code: bad });
        let b: any;
        try { const raw = await request.text(); if (raw.length > 64_000) return reply(413, { ok: false, code: "too_large" }); b = JSON.parse(raw); } catch { return reply(400, { ok: false, code: "INVALID_INPUT" }); }
        if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { ok: false, code: "INVALID_INPUT" });
        let session;
        try { session = await currentSession(authStore, request); } catch { return reply(503, { ok: false, code: "unavailable" }); }
        const deps = { config: gateConfig(), builder: builderCall, now: () => Date.now() };
        const { op, ...rest } = b;
        const r = op === "prepare" ? await gatePrepare(rest, session, deps)
          : op === "verify" ? await gateVerify(rest, session, deps)
          : { http: 400, body: { ok: false, code: "INVALID_INPUT" } };
        return reply(r.http, r.body);
      },
    },
  },
});
