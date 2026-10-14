// Load More for tool activity. Only answers when tracking is switched on; scoped to owned products.
import { createFileRoute } from "@tanstack/react-router";
import { reply } from "@/lib/creator-auth/http.server";
import { activityTrackingOn, buildActivity, decodeActivityCursor } from "@/lib/creator-dashboard/core";
import { sessionWallet } from "./dashboard";

export const Route = createFileRoute("/api/creator/dashboard/activity")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const wallet = await sessionWallet(request);
        if (wallet instanceof Response) return wallet;
        if (!activityTrackingOn(process.env["MCPX_TOOL_ACTIVITY"])) return reply(404, { error: "not_tracked" });
        const cursor = decodeActivityCursor(new URL(request.url).searchParams.get("cursor"));
        if (!cursor) return reply(400, { error: "bad_cursor" });
        try {
          const src = await import("@/lib/creator-dashboard/source.server");
          const products = await src.ownedProducts(wallet);
          const s = buildActivity(products, true, products.length ? await src.activityPage(products.map((p) => p.creationId), cursor) : []);
          return reply(200, s.state === "ok" ? { rows: s.data.rows, nextCursor: s.data.nextCursor } : { rows: [], nextCursor: null });
        } catch { return reply(503, { error: "unavailable" }); }
      },
    },
  },
});
