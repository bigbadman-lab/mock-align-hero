// Product identity resolution for product-scoped MCP endpoints (server-only logic, injectable deps).
// Trusted key = immutable mcp_creations.id (UUID). Slug, mint, name and wallet are never authorization keys.
import { adapterExact, type ProductSettings, type TemplateAdapter } from "./registry";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const parseCreationId = (raw: string): string | null => (raw.length === 36 && UUID_RE.test(raw) ? raw : null);

export interface VerifiedCreation { id: string; templateId: string; templateVersion: number; displayName: string }
export interface ProductConfig {
  creationId: string;
  templateId: string;
  templateVersion: string;
  configVersion: number;
  toolConfig: unknown;
  accessMode: "private" | "credential_required";
  lifecycleState: "inactive" | "active" | "suspended";
}

export interface ProductDeps {
  getVerifiedCreation(id: string): Promise<VerifiedCreation | null>;
  getProductConfig(id: string): Promise<ProductConfig | null>;
  /** Product-scoped credential check. Must never accept the platform-demo token. */
  authorizeProduct(product: ResolvedProduct, bearer: string): Promise<boolean>;
}

export interface ResolvedProduct {
  creationId: string;
  displayName: string;
  adapter: TemplateAdapter;
  settings: ProductSettings;
  configVersion: number;
  accessMode: ProductConfig["accessMode"];
}

export type ResolveResult =
  | { ok: true; product: ResolvedProduct }
  | { ok: false; reason: "not_found" | "inactive" | "misconfigured" | "store_unavailable" };

/** Fail-closed resolution. Any mismatch → not a product. */
export async function resolveProduct(deps: ProductDeps, id: string): Promise<ResolveResult> {
  let creation: VerifiedCreation | null, config: ProductConfig | null;
  try {
    creation = await deps.getVerifiedCreation(id);
    if (!creation) return { ok: false, reason: "not_found" };
    config = await deps.getProductConfig(id);
  } catch {
    return { ok: false, reason: "store_unavailable" };
  }
  if (!config || config.creationId !== creation.id) return { ok: false, reason: "not_found" };
  if (config.lifecycleState !== "active") return { ok: false, reason: "inactive" };
  if (config.templateId !== creation.templateId) return { ok: false, reason: "misconfigured" };
  const adapter = adapterExact(config.templateId, config.templateVersion);
  if (!adapter || Number(config.templateVersion.split(".")[0]) !== creation.templateVersion) return { ok: false, reason: "misconfigured" };
  const settings = adapter.parseSettings(config.toolConfig);
  if (!settings) return { ok: false, reason: "misconfigured" };
  return {
    ok: true,
    product: { creationId: creation.id, displayName: creation.displayName, adapter, settings, configVersion: config.configVersion, accessMode: config.accessMode },
  };
}
