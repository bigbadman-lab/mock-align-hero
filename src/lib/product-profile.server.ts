// Production data source for public profiles. Server-only; selects exact columns, bounded by 8 s timeout.
import type { ProfileDeps } from "./product-profile";

const T = () => AbortSignal.timeout(8_000);

export const productionProfileDeps: ProfileDeps = {
  async getCreationBySlug(slug) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("mcp_creations")
      .select("id, slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at")
      .eq("slug", slug).limit(1).abortSignal(T()).maybeSingle();
    if (error) throw new Error("unavailable");
    return data;
  },
  async getConfig(creationId) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("mcp_product_configs")
      .select("creation_id, template_id, template_version, tool_config, lifecycle_state")
      .eq("creation_id", creationId).abortSignal(T()).maybeSingle();
    if (error) throw new Error("unavailable");
    return data;
  },
};
