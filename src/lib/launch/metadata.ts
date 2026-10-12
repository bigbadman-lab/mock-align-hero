// Canonical token metadata serializer (Phase 04-E). The ONLY place token metadata JSON is produced.
// Shape follows the off-chain JSON Pump.fun reads from the create instruction's `uri`
// (name, symbol, description, image, showName, optional website). The builder's 200-character limit
// applies to that `uri` (the metadata URL), not to the creator's website link, which goes in `website`.
import type { Draft } from "./draft";

export const URI_MAX = 200; // builder contract: uri ≤ 200, https only

export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  showName: true;
  website?: string;
}

/** Fixed key order; only validated draft fields; never wallet, fees, supply or settings. */
export function buildMetadata(d: Pick<Draft, "tokenName" | "symbol" | "description" | "link">, imageUrl: string): { json: string; meta: TokenMetadata } {
  if (!/^https:\/\/[^\s"<>\\]+$/.test(imageUrl) || imageUrl.length > URI_MAX) throw new Error("image_url_invalid");
  const meta: TokenMetadata = { name: d.tokenName, symbol: d.symbol, description: d.description, image: imageUrl, showName: true };
  if (d.link) meta.website = d.link;
  return { json: JSON.stringify(meta), meta };
}

/** A metadata URL the builder would accept as `uri`; otherwise an explicit blocker, never truncation. */
export function checkUri(url: string): { ok: true } | { ok: false; error: "URI_TOO_LONG" | "URI_NOT_HTTPS" } {
  if (!/^https:\/\/[^\s]+$/.test(url)) return { ok: false, error: "URI_NOT_HTTPS" };
  if (url.length > URI_MAX) return { ok: false, error: "URI_TOO_LONG" };
  return { ok: true };
}
