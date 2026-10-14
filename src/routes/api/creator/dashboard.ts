// Signed-in creator dashboard data. Wallet comes ONLY from the session cookie — never a query param.
// Each section fails independently to "unavailable" so one outage never shows as zero.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { buildActivity, buildEarnings, buildRewards, type CfIntentRow, type ChildRow, type OwnedProduct, type SectionState } from "@/lib/creator-dashboard/core";
import type { DistributionRow } from "@/lib/treasury/core";

const safe = async <T,>(fn: () => Promise<SectionState<T>>): Promise<SectionState<T>> => { try { return await fn(); } catch { return { state: "unavailable" }; } };

export const Route = createFileRoute("/api/creator/dashboard")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        let wallet: string;
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          wallet = s.wallet;
        } catch { return reply(503, { error: "unavailable" }); }

        const db = (await import("@/integrations/supabase/client.server")).supabaseAdmin;
        let products: OwnedProduct[] | null = null;
        try {
          const { data, error } = await db.from("mcp_creations").select("id, slug, display_name, child_mint, verified_at")
            .eq("creator_wallet", wallet).order("verified_at", { ascending: false }).limit(50);
          if (error) throw error;
          products = (data ?? []).map((r) => ({ creationId: r.id, slug: r.slug, name: r.display_name, childMint: r.child_mint, verifiedAt: r.verified_at }));
        } catch { products = null; }

        const earnings = products === null ? { state: "unavailable" as const } : await safe(async () => {
          const mints = products!.map((p) => p.childMint);
          if (mints.length === 0) return buildEarnings([], [], [], wallet);
          const [c, i] = await Promise.all([
            db.from("mcpx_cf_children").select("mint, quote_mint, creator_wallet").in("mint", mints),
            db.from("mcpx_cf_intents").select("idempotency_key, mint, status, action, signature, finalized_slot, distributed_amount, updated_at").in("mint", mints).order("updated_at", { ascending: false }).limit(200),
          ]);
          if (c.error || i.error) throw new Error("ledger_unavailable");
          return buildEarnings(products!, (c.data ?? []) as ChildRow[], (i.data ?? []) as CfIntentRow[], wallet);
        });

        const rewards = await safe(async () => {
          const { getDistributions, getOverview } = await import("@/lib/treasury/source.server");
          const ov = await getOverview();
          if (!ov.mint) return buildRewards(null, [], wallet);
          const rows: DistributionRow[] = [];
          let before: number | undefined;
          for (let page = 0; page < 10; page++) { // bounded scan of the same projection Treasury uses
            const r = await getDistributions({ wallet, beforeSlot: before });
            rows.push(...r.rows);
            if (r.nextBeforeSlot === null) break;
            before = r.nextBeforeSlot;
          }
          return buildRewards(ov.mint, rows, wallet);
        });

        const activity = products === null ? { state: "unavailable" as const } : buildActivity(products);
        return reply(200, { wallet, products, earnings, rewards, activity });
      },
    },
  },
});
