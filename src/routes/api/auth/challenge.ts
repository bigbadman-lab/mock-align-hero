// Issues a single-use, 5-minute sign-in challenge for one wallet. The server builds the exact message.
import { createFileRoute } from "@tanstack/react-router";
import { createChallenge } from "@/lib/creator-auth/core";
import { authStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { hostOf, readMutation, reply } from "@/lib/creator-auth/http.server";

export const Route = createFileRoute("/api/auth/challenge")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readMutation(request, ["address"]);
        if (body instanceof Response) return body;
        if (!(await takeAuthBudget(request))) return reply(429, { error: "rate_limited" });
        try {
          const r = await createChallenge(authStore, String(body["address"]), hostOf(request));
          return r.ok ? reply(200, { nonce: r.nonce, message: r.message }) : reply(400, { error: r.error });
        } catch {
          return reply(503, { error: "unavailable" });
        }
      },
    },
  },
});
