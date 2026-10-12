// GET: current creator session (wallet + expiry only). POST: sign out (revokes server session, clears cookie).
import { createFileRoute } from "@tanstack/react-router";
import { clearCookie, currentSession, sha256 } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { readMutation, reply } from "@/lib/creator-auth/http.server";

export const Route = createFileRoute("/api/auth/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const s = await currentSession(authStore, request);
          return s ? reply(200, { signedIn: true, wallet: s.wallet, expiresAt: s.expiresAt }) : reply(200, { signedIn: false });
        } catch {
          return reply(503, { error: "unavailable" });
        }
      },
      POST: async ({ request }) => {
        const body = await readMutation(request, ["action"]);
        if (body instanceof Response) return body;
        if (body["action"] !== "sign_out") return reply(400, { error: "invalid_input" });
        try {
          const s = await currentSession(authStore, request);
          if (s) await authStore.revokeSession(await sha256(s.token));
          return reply(200, { signedIn: false }, { "set-cookie": clearCookie() });
        } catch {
          return reply(503, { error: "unavailable" }, { "set-cookie": clearCookie() });
        }
      },
    },
  },
});
