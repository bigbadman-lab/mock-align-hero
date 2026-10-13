// Creator BYOK management (cookie session only). On by default; MCPX_BYOK_DISABLED=1 is an emergency stop only.
// Fails closed if the server keyring is missing/invalid. Every operation re-checks session wallet == verified
// product creator inside runByok. Bearer/product keys never authenticate here. Responses never carry key material.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore, ownershipStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { readMutation, reply } from "@/lib/creator-auth/http.server";

const KEYS = ["action", "creationId", "provider", "apiKey", "model", "idempotencyKey", "expectedRevision", "enabled", "limits"];

async function availability(): Promise<"available" | "emergency_stopped" | "not_configured"> {
  if (process.env["MCPX_BYOK_DISABLED"] === "1") return "emergency_stopped";
  try {
    const { parseKeyring } = await import("@/lib/byok/crypto");
    await parseKeyring(process.env["MCPX_BYOK_KEYRING"]);
    return "available";
  } catch { return "not_configured"; }
}

export const Route = createFileRoute("/api/creator/ai")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const a = await availability();
        return reply(200, { available: a === "available", reason: a === "available" ? null : a });
      },
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const body = await readMutation(request, KEYS);
        if (body instanceof Response) return body;
        const a = await availability();
        if (a !== "available") return reply(503, { error: "byok_not_enabled", reason: a });
        if (!(await takeAuthBudget(request))) return reply(429, { error: "rate_limited" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          const [{ runByok }, { parseKeyring }, { serviceByokStore, takeByokTestBudget }] = await Promise.all([
            import("@/lib/byok/core"), import("@/lib/byok/crypto"), import("@/lib/byok/store.server"),
          ]);
          const u = (v: unknown) => (v === null ? undefined : v);
          const r = await runByok(
            { store: serviceByokStore, ownership: ownershipStore, sessionWallet: s.wallet, keyring: () => parseKeyring(process.env["MCPX_BYOK_KEYRING"]), takeTestBudget: takeByokTestBudget },
            body["creationId"], body["action"],
            { provider: u(body["provider"]), apiKey: u(body["apiKey"]), model: u(body["model"]), idempotencyKey: u(body["idempotencyKey"]),
              expectedRevision: u(body["expectedRevision"]), enabled: u(body["enabled"]), limits: u(body["limits"]) },
          );
          return reply(r.status, r.body);
        } catch {
          return reply(503, { error: "unavailable" }); // never echo the error: it could contain request data
        }
      },
    },
  },
});
