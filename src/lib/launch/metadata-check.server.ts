// Pre-sign metadata check: the URI must be one of our recorded, hash-verified artifacts whose JSON names this
// exact draft, and whose image is also a recorded artifact. Anything else blocks signing.
// URIs are either mcpx.fun asset URLs or our Pinata gateway URLs recorded in mcpx_launch_artifacts.
import type { GateDraft } from "@/lib/tx-builder/launch-gate";

const PREFIX = "/api/public/launch-assets/";
const localPath = (u: string): string | null => {
  try { const x = new URL(u); return x.protocol === "https:" && x.pathname.startsWith(PREFIX) && !x.search && !x.hash ? decodeURIComponent(x.pathname.slice(PREFIX.length)) : null; }
  catch { return null; }
};
async function pathOf(u: string): Promise<string | null> {
  const p = localPath(u);
  if (p) return p;
  const { isGatewayUrl } = await import("./pinata.server");
  if (!isGatewayUrl(u)) return null;
  const { pathForPublicUrl } = await import("./drafts.server");
  return pathForPublicUrl(u);
}

export async function checkMetadata(uri: string, dr: GateDraft): Promise<string | null> {
  const { readArtifact } = await import("./drafts.server");
  const p = await pathOf(uri);
  if (!p || !p.startsWith("metadata/")) return "METADATA_URI_NOT_RECORDED";
  const a = await readArtifact(p);
  if (!a || a.contentType !== "application/json") return "METADATA_URI_NOT_RECORDED";
  let m: Record<string, unknown>;
  try { m = JSON.parse(new TextDecoder().decode(a.bytes)); } catch { return "METADATA_INVALID"; }
  if (m["name"] !== dr.name || m["symbol"] !== dr.symbol) return "METADATA_DRAFT_MISMATCH";
  const ip = typeof m["image"] === "string" ? await pathOf(m["image"]) : null;
  if (!ip || !ip.startsWith("artwork/")) return "METADATA_IMAGE_NOT_RECORDED";
  const img = await readArtifact(ip);
  if (!img || !/^image\/(png|jpeg)$/.test(img.contentType)) return "METADATA_IMAGE_NOT_RECORDED";
  return null;
}
