// Production wiring for product resolution: server-only reads, no fixtures.
import type { ProductConfig, ProductDeps } from "./products";
import { authorizeProductKey, readPepper } from "./keys";
import { productionKeyStore } from "./keys.server";

export const productionProductDeps: ProductDeps = {
  async getVerifiedCreation(id) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("mcp_creations")
      .select("id, template_id, template_version, display_name")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error("store_unavailable");
    return data ? { id: data.id, templateId: data.template_id, templateVersion: data.template_version, displayName: data.display_name } : null;
  },
  async getProductConfig(id) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("mcp_product_configs")
      .select("creation_id, template_id, template_version, config_version, tool_config, access_mode, lifecycle_state")
      .eq("creation_id", id)
      .maybeSingle();
    if (error) throw new Error("store_unavailable");
    return data
      ? {
          creationId: data.creation_id,
          templateId: data.template_id,
          templateVersion: data.template_version,
          configVersion: data.config_version,
          toolConfig: data.tool_config,
          accessMode: data.access_mode as ProductConfig["accessMode"],
          lifecycleState: data.lifecycle_state as ProductConfig["lifecycleState"],
        }
      : null;
  },
  async getCanvasVersion(id) {
    const { canvasProductsEnabled } = await import("@/lib/canvas/products.server");
    if (!canvasProductsEnabled()) return null;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("mcpx_canvas_product_versions").select("version, config").eq("creation_id", id)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error("store_unavailable");
    return data ? { version: data.version, config: data.config } : null;
  },
  // Product key checked against the SAME creation id on every request; missing pepper = deny.
  async authorizeProduct(product, bearer) {
    const pepper = readPepper();
    if (!pepper) return false;
    return authorizeProductKey(productionKeyStore, pepper, product.creationId, bearer);
  },
};
