// Creator Canvas workspace (cookie session). Lists only Canvas products whose verified creator is the session
// wallet; saving appends a validated, immutable version and must name the version being edited.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { readMutation, reply } from "@/lib/creator-auth/http.server";
import { canvasProductsEnabled, listCanvasProducts, putCanvasVersion } from "@/lib/canvas/products.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE: Record<string, number> = { not_found: 404, not_canvas: 404, not_bound: 409, stale_version: 409, invalid: 400 };

export const Route = createFileRoute("/api/creator/canvas")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          if (!canvasProductsEnabled()) return reply(200, { available: false, products: [] });
          return reply(200, { available: true, products: await listCanvasProducts(s.wallet) });
        } catch { return reply(503, { error: "unavailable" }); }
      },
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const body = await readMutation(request, ["creationId", "expectedVersion", "canvas"]);
        if (body instanceof Response) return body;
        const { creationId, expectedVersion, canvas } = body as { creationId: unknown; expectedVersion: unknown; canvas: unknown };
        if (typeof creationId !== "string" || !UUID.test(creationId) || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) return reply(400, { error: "invalid_input" });
        if (!canvasProductsEnabled()) return reply(503, { error: "canvas_products_unavailable" });
        if (!(await takeAuthBudget(request))) return reply(429, { error: "rate_limited" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          const r = await putCanvasVersion(s.wallet, creationId, canvas, expectedVersion);
          if (r.startsWith("ok:")) return reply(200, { version: Number(r.slice(3)) });
          return reply(CODE[r] ?? 400, { error: r });
        } catch { return reply(503, { error: "unavailable" }); }
      },
    },
  },
});
