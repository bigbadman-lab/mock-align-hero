// Public product profile contract (pure logic; data sources are injected so tests use fixtures only).
// Only allowlisted, evidence-backed fields leave the server. Raw tool_config, keys, audit events never do.
import * as z from "zod/v4";
import { adapterExact } from "@/lib/mcp-gateway/registry";
import { TEMPLATES } from "@/lib/templates";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const PRODUCT_ENDPOINT_BASE = "https://mcpx.fun/api/public/mcp/products/";
/** Future alias. Not routed; never presented as usable. */
export const FUTURE_ALIAS_PATTERN = "https://mcp.mcpx.fun/{creation-id}/mcp";
export const TESTED_PROTOCOL = "2025-11-25";

export interface ProfileCreationRow {
  id: string; slug: string; template_id: string; template_version: number; display_name: string; ticker: string;
  description: string; creator_wallet: string; child_mint: string; quote_mint: string; network: string;
  verified_tx_signature: string; verified_slot: number; verified_at: string;
  /** 'SOL_REHEARSAL' marks a permanent pre-$MCP SOL-paired test product. */
  pair_kind?: string | null;
}
export interface ProfileConfigRow {
  creation_id: string; template_id: string; template_version: string; tool_config: unknown;
  lifecycle_state: string;
}
export interface ProfileDeps {
  getCreationBySlug(slug: string): Promise<ProfileCreationRow | null>;
  getConfig(creationId: string): Promise<ProfileConfigRow | null>;
  /** Optional: validated launch artwork URL for this mint (best-effort, never fails the profile). */
  getArtworkUrl?(mint: string): Promise<string | null>;
}

export type Availability = "active" | "inactive" | "suspended" | "not_configured" | "misconfigured";

export interface PublicTool { name: string; adapterVersion: string; title: string; description: string; inputSchema: string; fixedSettings: string[] }
export interface PublicProfile {
  creationId: string; slug: string; displayName: string; ticker: string; description: string;
  templateId: string; templateName: string; engine: string | null; templateVersion: number;
  creatorWallet: string; childMint: string; quoteMint: string; network: string;
  verifiedTx: string; verifiedSlot: number; verifiedAt: string;
  /** Permanent SOL rehearsal marker (not $MCP-paired). */
  rehearsal: boolean;
  /** Same-origin launch artwork URL, or null. */
  imageUrl: string | null;
  availability: Availability;
  tool: PublicTool | null;
  /** Present only when the product endpoint can actually serve this product. */
  endpoint: string | null;
}

export type ProfileResult =
  | { status: "ok"; profile: PublicProfile }
  | { status: "not_found" }
  | { status: "unavailable" };

export async function loadProfile(deps: ProfileDeps, rawSlug: string): Promise<ProfileResult> {
  return (await resolveProfile(deps, rawSlug)).result;
}

/** Server-only: the public profile plus the resolved adapter and server-fixed settings (never sent to browsers). */
export async function resolveProfile(deps: ProfileDeps, rawSlug: string): Promise<{ result: ProfileResult; adapter: TemplateAdapter | null; settings: ProductSettings | null }> {
  const r = await resolveInner(deps, rawSlug);
  return "result" in r ? r : { result: r, adapter: null, settings: null };
}

async function resolveInner(deps: ProfileDeps, rawSlug: string): Promise<ProfileResult | { result: ProfileResult; adapter: TemplateAdapter | null; settings: ProductSettings | null }> {
  const slug = String(rawSlug ?? "").toLowerCase();
  if (!SLUG_RE.test(slug)) return { status: "not_found" };
  let c: ProfileCreationRow | null, cfg: ProfileConfigRow | null = null;
  try {
    c = await deps.getCreationBySlug(slug);
    if (!c || c.slug !== slug) return { status: "not_found" };
    cfg = await deps.getConfig(c.id); // canonical id, never the slug
  } catch {
    return { status: "unavailable" };
  }
  const tpl = TEMPLATES.find((t) => t.id === c.template_id);
  let availability: Availability = "not_configured";
  let tool: PublicTool | null = null;
  let runAdapter: TemplateAdapter | null = null, runSettings: ProductSettings | null = null;
  if (cfg && cfg.creation_id === c.id) {
    const adapter = cfg.template_id === c.template_id ? adapterExact(cfg.template_id, cfg.template_version) : null;
    const settings = adapter && Number(cfg.template_version.split(".")[0]) === c.template_version ? adapter.parseSettings(cfg.tool_config) : null;
    if (!adapter || !settings) availability = "misconfigured";
    else {
      runAdapter = adapter; runSettings = settings;
      availability = cfg.lifecycle_state === "active" ? "active" : cfg.lifecycle_state === "suspended" ? "suspended" : "inactive";
      tool = {
        name: adapter.toolName, adapterVersion: adapter.version, title: adapter.title, description: adapter.description,
        inputSchema: JSON.stringify(z.toJSONSchema(adapter.inputSchema), null, 2), fixedSettings: adapter.describeSettings(settings),
      };
    }
  }
  let imageUrl: string | null = null;
  try {
    const u = deps.getArtworkUrl ? await deps.getArtworkUrl(c.child_mint) : null;
    imageUrl = u && /^https:\/\/(www\.)?mcpx\.fun\/api\/public\/launch-assets\/artwork\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(u) ? u : null;
  } catch { imageUrl = null; }
  const result: ProfileResult = {
    status: "ok",
    profile: {
      creationId: c.id, slug: c.slug, displayName: c.display_name, ticker: c.ticker, description: c.description,
      templateId: c.template_id, templateName: tpl?.name ?? c.template_id, engine: tpl?.engine ?? null, templateVersion: c.template_version,
      creatorWallet: c.creator_wallet, childMint: c.child_mint, quoteMint: c.quote_mint, network: c.network,
      verifiedTx: c.verified_tx_signature, verifiedSlot: c.verified_slot, verifiedAt: c.verified_at,
      rehearsal: c.pair_kind === "SOL_REHEARSAL",
      imageUrl,
      availability, tool,
      endpoint: availability === "active" && tool ? PRODUCT_ENDPOINT_BASE + c.id : null,
    },
  };
  return { result, adapter: runAdapter, settings: runSettings };
}
