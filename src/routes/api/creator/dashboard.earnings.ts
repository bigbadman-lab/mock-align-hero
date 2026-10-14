// Load More for creator earnings. Cursor-paged, scoped to the session wallet's verified products.
import { createFileRoute } from "@tanstack/react-router";
import { reply } from "@/lib/creator-auth/http.server";
import { decodeCursor, pageEarnings } from "@/lib/creator-dashboard/core";
import { sessionWallet } from "./dashboard";

export const Route = createFileRoute("/api/creator/dashboard/earnings")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const wallet = await sessionWallet(request);
        if (wallet instanceof Response) return wallet;
        const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor"));
        if (!cursor) return reply(400, { error: "bad_cursor" });
        try {
          const src = await import("@/lib/creator-dashboard/source.server");
          const products = await src.ownedProducts(wallet);
          const mints = products.map((p) => p.childMint);
          if (!mints.length) return reply(200, { rows: [], nextCursor: null, assets: {} });
          const [children, page] = await Promise.all([src.childrenFor(mints), src.confirmedPage(mints, cursor)]);
          const { getOverview } = await import("@/lib/treasury/source.server");
          const official = await getOverview().then((o) => o.mint).catch(() => null);
          const assets = await src.quoteAssets(children.filter((c) => c.creator_wallet === wallet).map((c) => c.quote_mint), official);
          return reply(200, pageEarnings(products, children, page, wallet, 20, assets));
        } catch { return reply(503, { error: "unavailable" }); }
      },
    },
  },
});
