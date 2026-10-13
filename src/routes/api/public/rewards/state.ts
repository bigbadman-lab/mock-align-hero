import { createFileRoute } from "@tanstack/react-router";
import { checkSealed, deny, okJson } from "@/lib/rewards/remote.server";

// Rewards worker → site: launch config (mint is the single go-live input) + schema readiness. Worker-only.
const TABLES = ["mcpx_rw_hix_window_cutoffs", "mcpx_rw_hix_frozen_snapshots", "mcpx_rw_hix_frozen_owners", "mcpx_rw_hix_holds", "mcpx_rw_eligibility_policies"];

export const Route = createFileRoute("/api/public/rewards/state")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const c = await checkSealed(request, "/api/public/rewards/state");
        if (c instanceof Response) return c;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const sb = supabaseAdmin as any;
        const { data, error } = await sb.from("mcpx_rw_config").select("mint, deployer_wallet, anchor_slot, genesis_window, emergency_stop").eq("id", 1).maybeSingle();
        if (error) return deny(503, "CONFIG_UNAVAILABLE");
        const checks = await Promise.all(TABLES.map((t) => sb.from(t).select("*", { head: true, count: "exact" }).limit(0)));
        return okJson({
          config: data ? { mint: data.mint, deployerWallet: data.deployer_wallet, anchorSlot: data.anchor_slot === null ? null : String(data.anchor_slot),
            genesisWindow: data.genesis_window === null ? null : String(data.genesis_window), emergencyStop: data.emergency_stop === true } : null,
          schemaReady: checks.every((r: any) => !r.error),
        });
      },
    },
  },
});
