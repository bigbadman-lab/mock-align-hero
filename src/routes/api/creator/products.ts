// Creator management (cookie session). Lists only products whose verified creator is the session wallet;
// key actions re-check ownership on every request. Product API keys are never accepted here.
import { createFileRoute } from "@tanstack/react-router";
import { authorizeCreator, currentSession } from "@/lib/creator-auth/core";
import { authStore, listKeyMetadata, listOwnedProducts, ownershipStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { readMutation, reply } from "@/lib/creator-auth/http.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const Route = createFileRoute("/api/creator/products")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" }); // bearer keys never authenticate management
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          return reply(200, { wallet: s.wallet, products: await listOwnedProducts(s.wallet) });
        } catch {
          return reply(503, { error: "unavailable" });
        }
      },
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const body = await readMutation(request, ["action", "creationId", "keyId", "idempotencyKey"]);
        if (body instanceof Response) return body;
        const { action, creationId, keyId, idempotencyKey } = body as Record<string, string | null>;
        if (typeof creationId !== "string" || !UUID.test(creationId) || !["list_keys", "issue", "rotate", "revoke"].includes(String(action))) return reply(400, { error: "invalid_input" });
        if (keyId !== null && (typeof keyId !== "string" || !UUID.test(keyId))) return reply(400, { error: "invalid_input" });
        if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey))) return reply(400, { error: "invalid_input" });
        if (!(await takeAuthBudget(request))) return reply(429, { error: "rate_limited" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          if (!(await authorizeCreator(ownershipStore, s.wallet, creationId))) return reply(404, { error: "not_found" });
          const actorRef = `wallet:${s.wallet}`.slice(0, 96);
          if (action === "list_keys") return reply(200, { keys: await listKeyMetadata(creationId) });
          if (action === "revoke") {
            if (!keyId) return reply(400, { error: "invalid_input" });
            const { revokeProductKeyAs } = await import("@/lib/mcp-gateway/keys.server");
            return reply(200, { revoked: await revokeProductKeyAs(creationId, keyId, "creator", actorRef) });
          }
          if (!idempotencyKey || (action === "rotate" && !keyId)) return reply(400, { error: "invalid_input" });
          const { issueProductKey } = await import("@/lib/mcp-gateway/keys.server");
          const r = await issueProductKey({ creationId, actorKind: "creator", actorRef, idempotencyKey, ...(action === "rotate" && keyId ? { rotateKeyId: keyId } : {}) });
          // Plaintext shown once; a replayed request cannot recover it.
          return reply(200, r.plaintext ? { keyId: r.keyId, key: r.plaintext, shownOnce: true } : { keyId: r.keyId, key: null, alreadyProcessed: true });
        } catch {
          return reply(503, { error: "unavailable" });
        }
      },
    },
  },
});
