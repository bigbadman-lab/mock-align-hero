// Creator launch drafts (cookie session). Wallet comes only from the verified session; every query is
// scoped to it, so another creator's draft is indistinguishable from a missing one (404).
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { DRAFT_BODY_MAX, parseDraftBody } from "@/lib/launch/drafts-core";

const STATUS: Record<string, number> = { method_not_allowed: 405, forbidden: 403, unsupported_media_type: 415, too_large: 413 };
const CONFLICT: Record<string, number> = { canvas_storage_unavailable: 409, not_found: 404, stale_revision: 409, too_many_drafts: 409, storage_limit: 409, artwork_required: 409, uri_too_long: 409 };

export const Route = createFileRoute("/api/creator/launch-drafts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          const { listDrafts } = await import("@/lib/launch/drafts.server");
          return reply(200, { drafts: await listDrafts(s.wallet) });
        } catch { return reply(503, { error: "unavailable" }); }
      },
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: DRAFT_BODY_MAX });
        if (bad) return reply(STATUS[bad] ?? 400, { error: bad });
        const raw = await request.text();
        if (raw.length > DRAFT_BODY_MAX) return reply(413, { error: "too_large" });
        let b: unknown;
        try { b = JSON.parse(raw); } catch { return reply(400, { error: "invalid_input" }); }
        if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { error: "invalid_input" });
        const p = parseDraftBody(b as Record<string, unknown>);
        if ("error" in p) return reply(400, p);
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          const m = await import("@/lib/launch/drafts.server");
          if (p.action !== "get" && !(await m.takeLaunchBudget(s.wallet, "save"))) return reply(429, { error: "rate_limited" });
          const origin = `https://${request.headers.get("host")}`; // host already checked against ALLOWED_HOSTS
          try {
            if (p.action === "get") { const d = await m.getDraft(s.wallet, p.id); return d ? reply(200, { draft: d }) : reply(404, { error: "not_found" }); }
            if (p.action === "create") return reply(200, { draft: await m.createDraft(s.wallet, p.createKey, p.draft) });
            if (p.action === "update") return reply(200, { draft: await m.updateDraft(s.wallet, p.id, p.revision, p.draft) });
            if (p.action === "abandon") { await m.abandonDraft(s.wallet, p.id, p.revision!); return reply(200, { abandoned: true }); }
            return reply(200, { draft: await m.prepareMetadata(s.wallet, origin, p.id, p.revision!) });
          } catch (e) {
            if (e instanceof m.Conflict) return reply(CONFLICT[e.code] ?? 409, { error: e.code });
            throw e;
          }
        } catch { return reply(503, { error: "unavailable" }); }
      },
    },
  },
});
