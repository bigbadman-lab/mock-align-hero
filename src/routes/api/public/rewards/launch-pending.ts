import { createFileRoute } from "@tanstack/react-router";
import { checkSealed, deny, okJson } from "@/lib/rewards/remote.server";

// Rewards worker → site: is any launch claim waiting? Worker-only (sealed); returns a count and a timestamp only.
export const Route = createFileRoute("/api/public/rewards/launch-pending")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const c = await checkSealed(request, "/api/public/rewards/launch-pending");
        if (c instanceof Response) return c;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error, count } = await (supabaseAdmin as any).from("mcpx_cf_launch_claims")
          .select("created_at", { count: "exact" }).eq("status", "PENDING").order("created_at", { ascending: false }).limit(1);
        if (error) return deny(503, "CLAIMS_UNAVAILABLE");
        return okJson({ pending: count ?? 0, newestCreatedAt: data?.[0]?.created_at ?? null });
      },
    },
  },
});
