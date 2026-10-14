// Production data source for public profiles. Server-only; selects exact columns, bounded by 8 s timeout.
import type { ProfileDeps } from "./product-profile";

const T = () => AbortSignal.timeout(8_000);

export const productionProfileDeps: ProfileDeps = {
  async getCreationBySlug(slug) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("mcp_creations")
      .select("id, slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at, pair_kind")
      .eq("slug", slug).limit(1).abortSignal(T()).maybeSingle();
    if (error) throw new Error("unavailable");
    return data;
  },
  async getArtworkUrl(mint) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as unknown as { from(t: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { data: claim } = await db.from("mcpx_cf_launch_claims").select("draft_id").eq("mint", mint).limit(1).abortSignal(T()).maybeSingle();
    if (!claim?.draft_id) return null;
    const { data: draft } = await db.from("mcpx_launch_drafts").select("artwork_id").eq("id", claim.draft_id).abortSignal(T()).maybeSingle();
    if (!draft?.artwork_id) return null;
    const { data: art } = await db.from("mcpx_launch_artifacts").select("public_url").eq("id", draft.artwork_id).eq("kind", "artwork").abortSignal(T()).maybeSingle();
    return typeof art?.public_url === "string" ? art.public_url : null;
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
