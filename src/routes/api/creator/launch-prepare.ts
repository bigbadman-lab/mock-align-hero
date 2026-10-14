// Child launch preparation (creator cookie session + CSRF). Disabled unless MCPX_CHILD_LAUNCH_ENABLED=1.
// GET  → { enabled } only (no secrets, no addresses).
// POST { op: "prepare", draftId, revision, mint, idempotencyKey, connectedWallet } builds an unsigned
//      candidate from the creator's own saved draft, bound to the session wallet;
// POST { op: "verify", ... } re-checks it immediately before the wallet signs. Never signs or sends.
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { gatePrepareDraft, gateVerify, type GateDraft } from "@/lib/tx-builder/launch-gate";
import { builderCall, gateConfig } from "@/lib/tx-builder/client.server";

const STATUS: Record<string, number> = { method_not_allowed: 405, forbidden: 403, unsupported_media_type: 415, too_large: 413 };

async function loadDraft(wallet: string, id: string): Promise<GateDraft | null> {
  const { getDraft } = await import("@/lib/launch/drafts.server");
  const v = await getDraft(wallet, id);
  if (!v) return null;
  return { id: v.id, revision: v.revision, templateId: v.input.templateId, name: v.input.tokenName, symbol: v.input.symbol, uri: v.metadata?.url ?? null };
}

export const Route = createFileRoute("/api/creator/launch-prepare")({
  server: {
    handlers: {
      GET: async () => reply(200, { enabled: gateConfig().enabled }),
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { ok: false, code: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: 64_000 });
        if (bad) return reply(STATUS[bad] ?? 400, { ok: false, code: bad });
        let b: any;
        try { const raw = await request.text(); if (raw.length > 64_000) return reply(413, { ok: false, code: "too_large" }); b = JSON.parse(raw); } catch { return reply(400, { ok: false, code: "INVALID_INPUT" }); }
        if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { ok: false, code: "INVALID_INPUT" });
        let session;
        try { session = await currentSession(authStore, request); } catch { return reply(503, { ok: false, code: "unavailable" }); }
        const { canonicalMint } = await import("@/lib/tx-builder/canonical-mint.server");
        const deps = { config: gateConfig(), builder: builderCall, now: () => Date.now(), loadDraft, canonicalMint };
        const { op, ...rest } = b;
        const r = op === "prepare" ? await gatePrepareDraft(rest, session, deps)
          : op === "verify" ? await gateVerify(rest, session, deps)
          : { http: 400, body: { ok: false, code: "INVALID_INPUT" } };
        return reply(r.http, r.body);
      },
    },
  },
});
