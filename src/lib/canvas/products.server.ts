// Server-only Canvas product store (pending migration 0024). Canvas pipelines attach to a product ONLY through
// mcpx_canvas_bind on a verified registry row (mcp_creations exists only after on-chain verification); a prepared
// or signed transaction never binds anything and never changes a draft's status. Edits append immutable versions.
// Off until 0024 is applied and MCPX_CANVAS_PRODUCTS=1 is set, so nothing queries tables that don't exist yet.
import { validateCanvas, type CanvasConfig } from "./validate";

export const canvasProductsEnabled = () => process.env["MCPX_CANVAS_PRODUCTS"] === "1";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated types predate 0024
const admin = async (): Promise<any> => (await import("@/integrations/supabase/client.server")).supabaseAdmin;

export type CanvasProduct = { creationId: string; slug: string; name: string; childMint: string; version: number | null; config: CanvasConfig | null; updatedAt: string | null };
export type BindResult = "bound" | "already_bound" | "bound_to_other" | "not_verified" | "not_canvas" | "revision_not_found" | "creator_mismatch";

export async function listCanvasProducts(wallet: string): Promise<CanvasProduct[]> {
  const db = await admin();
  const { data: cs, error } = await db.from("mcp_creations").select("id, slug, display_name, child_mint").eq("creator_wallet", wallet).eq("template_id", "canvas").limit(50);
  if (error) throw new Error("canvas_store_unavailable");
  if (!cs?.length) return [];
  const { data: vs, error: ve } = await db.from("mcpx_canvas_product_versions").select("creation_id, version, config, created_at").in("creation_id", cs.map((c: { id: string }) => c.id)).order("version", { ascending: false });
  if (ve) throw new Error("canvas_store_unavailable");
  return cs.map((c: { id: string; slug: string; display_name: string; child_mint: string }) => {
    const v = (vs ?? []).find((x: { creation_id: string }) => x.creation_id === c.id);
    const chk = v ? validateCanvas(v.config) : null;
    return { creationId: c.id, slug: c.slug, name: c.display_name, childMint: c.child_mint, version: v?.version ?? null, config: chk?.ok ? chk.config : null, updatedAt: v?.created_at ?? null };
  });
}

export async function isOwnedCanvasProduct(wallet: string, creationId: string): Promise<boolean> {
  const db = await admin();
  const { data, error } = await db.from("mcp_creations").select("id").eq("id", creationId).eq("creator_wallet", wallet).eq("template_id", "canvas").maybeSingle();
  if (error) throw new Error("canvas_store_unavailable");
  return !!data;
}

/** Append a validated version. Result: "ok:<n>" | not_found | not_canvas | not_bound | stale_version | invalid. */
export async function putCanvasVersion(wallet: string, creationId: string, raw: unknown, expected: number): Promise<string> {
  const v = validateCanvas(raw);
  if (!v.ok) return "invalid";
  const db = await admin();
  const { data, error } = await db.rpc("mcpx_canvas_put_version", { _creation: creationId, _wallet: wallet, _config: v.config, _catalog: v.config.catalogVersion, _expected: expected });
  if (error) throw new Error("canvas_store_unavailable");
  return String(data);
}

/** Called only by the server-side creation verifier AFTER it has written the verified mcp_creations row. */
export async function bindCanvasOnVerifiedCreation(creationId: string, draftId: string, draftRevision: number): Promise<BindResult> {
  const db = await admin();
  const { data, error } = await db.rpc("mcpx_canvas_bind", { _creation: creationId, _draft: draftId, _rev: draftRevision });
  if (error) throw new Error("canvas_store_unavailable");
  return data as BindResult;
}
