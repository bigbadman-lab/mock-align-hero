// Verifies a signed challenge and sets the HttpOnly creator session cookie.
import { createFileRoute } from "@tanstack/react-router";
import { SESSION_TTL_MS, sessionCookie, verifySignIn } from "@/lib/creator-auth/core";
import { authStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { hostOf, readMutation, reply } from "@/lib/creator-auth/http.server";

export const Route = createFileRoute("/api/auth/verify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readMutation(request, ["address", "nonce", "signature"]);
        if (body instanceof Response) return body;
        if (!(await takeAuthBudget(request))) return reply(429, { error: "rate_limited" });
        try {
          const r = await verifySignIn(authStore, {
            address: String(body["address"]), nonce: String(body["nonce"]), signature: String(body["signature"]), host: hostOf(request),
          });
          if (!r.ok) return reply(401, { error: r.error });
          return reply(200, { wallet: r.wallet, expiresAt: r.expiresAt }, { "set-cookie": sessionCookie(r.token, SESSION_TTL_MS / 1000) });
        } catch {
          return reply(503, { error: "unavailable" });
        }
      },
    },
  },
});
