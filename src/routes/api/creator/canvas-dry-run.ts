// Canvas dry run (signed-in creators only). Read-only: runs a validated pipeline of existing tools through
// the same signed worker call and shared rate-limit budget as every tool page. Not a live product, no MCP endpoint.
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { callWorker, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";
import { runCanvas } from "@/lib/canvas/run";

const MAX = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUS: Record<string, number> = { method_not_allowed: 405, forbidden: 403, unsupported_media_type: 415, too_large: 413 };

export const Route = createFileRoute("/api/creator/canvas-dry-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: MAX });
        if (bad) return reply(STATUS[bad] ?? 400, { error: bad });
        const raw = await request.text();
        if (raw.length > MAX) return reply(413, { error: "too_large" });
        let b: unknown;
        try { b = JSON.parse(raw); } catch { return reply(400, { error: "invalid_input" }); }
        if (!b || typeof b !== "object" || Array.isArray(b) || !["canvas,input", "canvas,creationId,input"].includes(Object.keys(b).sort().join(","))) return reply(400, { error: "invalid_input" });
        const body = b as { canvas: unknown; input: unknown; creationId?: unknown };
        if (body.creationId !== undefined && (typeof body.creationId !== "string" || !UUID.test(body.creationId))) return reply(400, { error: "invalid_input" });
        // AI step: only for the session creator's own launched Canvas product, with that product's own key and limits.
        let summarise: ((r: unknown) => Promise<{ status: string; text?: string; model?: string }>) | undefined;
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          if (typeof body.creationId === "string") {
            const { canvasProductsEnabled, isOwnedCanvasProduct } = await import("@/lib/canvas/products.server");
            if (!canvasProductsEnabled() || !(await isOwnedCanvasProduct(s.wallet, body.creationId))) return reply(404, { error: "not_found" });
            const { productionAiDeps } = await import("@/lib/byok/store.server");
            const { summarise: sum } = await import("@/lib/byok/execute");
            const deps = await productionAiDeps();
            const id = body.creationId;
            if (deps) summarise = (r) => sum(deps, id, r);
          }
        } catch { return reply(503, { error: "unavailable" }); }
        const cfg = workerConfig();
        if (!cfg) return reply(503, { error: "worker_not_configured" });
        const traceId = crypto.randomUUID();
        const ready = new Map<string, boolean>();
        const out = await runCanvas(body.canvas, body.input, {
          traceId, now: Date.now, ...(summarise ? { summarise } : {}),
          available: async (id) => { if (!ready.has(id)) ready.set(id, (await toolAvailability(id)).available); return ready.get(id)!; },
          take: () => takeShared(cfg, request), // shared buckets only; no free-test allowance is consumed
          execute: async (p) => { const r = await callWorker(cfg, p, request); return r.ok ? r : { ok: false, error: r.error }; },
        });
        if (!out.ok) return reply(400, out);
        console.log(JSON.stringify({ canvasDryRun: traceId, complete: out.complete, steps: out.steps.map((x) => [x.capabilityId, x.status]) }));
        return reply(200, out);
      },
    },
  },
});
