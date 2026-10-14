// Pre-sign metadata check: the URI must be one of our recorded, hash-verified artifacts whose JSON names this
// exact draft, and whose image is also a recorded artifact. Anything else blocks signing.
import type { GateDraft } from "@/lib/tx-builder/launch-gate";

const PREFIX = "/api/public/launch-assets/";
const pathOf = (u: string): string | null => {
  try { const x = new URL(u); return x.protocol === "https:" && x.pathname.startsWith(PREFIX) && !x.search && !x.hash ? decodeURIComponent(x.pathname.slice(PREFIX.length)) : null; }
  catch { return null; }
};

export async function checkMetadata(uri: string, dr: GateDraft): Promise<string | null> {
  const { readArtifact } = await import("./drafts.server");
  const p = pathOf(uri);
  if (!p || !p.startsWith("metadata/")) return "METADATA_URI_NOT_RECORDED";
  const a = await readArtifact(p);
  if (!a || a.contentType !== "application/json") return "METADATA_URI_NOT_RECORDED";
  let m: Record<string, unknown>;
  try { m = JSON.parse(new TextDecoder().decode(a.bytes)); } catch { return "METADATA_INVALID"; }
  if (m["name"] !== dr.name || m["symbol"] !== dr.symbol) return "METADATA_DRAFT_MISMATCH";
  const ip = typeof m["image"] === "string" ? pathOf(m["image"]) : null;
  if (!ip || !ip.startsWith("artwork/")) return "METADATA_IMAGE_NOT_RECORDED";
  const img = await readArtifact(ip);
  if (!img || !/^image\/(png|jpeg)$/.test(img.contentType)) return "METADATA_IMAGE_NOT_RECORDED";
  return null;
}
