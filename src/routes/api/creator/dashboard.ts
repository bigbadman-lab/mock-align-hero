// Signed-in creator dashboard data. Wallet comes ONLY from the session cookie — never a query param.
// Each section fails independently to "unavailable" so one outage never shows as zero.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { activityTrackingOn, buildActivity, buildEarnings, buildRewards, EARNINGS_TOTALS_SCAN, type OwnedProduct, type SectionState } from "@/lib/creator-dashboard/core";
import type { DistributionRow } from "@/lib/treasury/core";

const safe = async <T,>(fn: () => Promise<SectionState<T>>): Promise<SectionState<T>> => { try { return await fn(); } catch { return { state: "unavailable" }; } };
const REWARD_PAGES = 10;

/** Shared by the dashboard and its Load More routes. Returns the session wallet or a ready error response. */
export async function sessionWallet(request: Request): Promise<string | Response> {
  if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
  try {
    const s = await currentSession(authStore, request);
    return s ? s.wallet : reply(401, { error: "unauthorized" });
  } catch { return reply(503, { error: "unavailable" }); }
}

export const Route = createFileRoute("/api/creator/dashboard")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const wallet = await sessionWallet(request);
        if (wallet instanceof Response) return wallet;
        const src = await import("@/lib/creator-dashboard/source.server");
        const { getDistributions, getOverview } = await import("@/lib/treasury/source.server");

        let products: OwnedProduct[] | null = null;
        try { products = await src.ownedProducts(wallet); } catch { products = null; }

        const earnings = products === null ? { state: "unavailable" as const } : await safe(async () => {
          const mints = products!.map((p) => p.childMint);
          if (mints.length === 0) return buildEarnings([], [], [], wallet);
          const [children, scan, first, pending] = await Promise.all([src.childrenFor(mints), src.totalsScan(mints), src.confirmedPage(mints, null), src.pendingCount(mints)]);
          const official = await getOverview().then((o) => o.mint).catch(() => null);
          const assets = await src.quoteAssets(children.filter((c) => c.creator_wallet === wallet).map((c) => c.quote_mint), official);
          return buildEarnings(products!, children, scan, wallet, { firstPage: first, pendingIntents: pending, assets, scanLimit: EARNINGS_TOTALS_SCAN });
        });

        const rewards = await safe(async () => {
          const ov = await getOverview();
          if (!ov.mint) return buildRewards(null, [], wallet);
          const rows: DistributionRow[] = [];
          let before: number | undefined; let limited = true;
          for (let page = 0; page < REWARD_PAGES; page++) { // bounded scan of the same projection Treasury uses
            const r = await getDistributions({ wallet, beforeSlot: before });
            rows.push(...r.rows);
            if (r.nextBeforeSlot === null) { limited = false; break; }
            before = r.nextBeforeSlot;
          }
          return buildRewards(ov.mint, rows, wallet, limited);
        });

        const tracking = activityTrackingOn(process.env["MCPX_TOOL_ACTIVITY"]);
        const activity = products === null ? { state: "unavailable" as const } : await safe(async () =>
          buildActivity(products!, tracking, tracking && products!.length ? await src.activityPage(products!.map((p) => p.creationId), null) : []));
        return reply(200, { wallet, products, earnings, rewards, activity });
      },
    },
  },
});
