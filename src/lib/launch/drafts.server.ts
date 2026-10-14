// Server-only persistence for creator launch drafts, artwork and metadata (Phase 04-E).
// Tables have RLS on with no browser policies; every query here is scoped by the session wallet.
import { TEMPLATES } from "@/lib/templates";
import { sha256 } from "@/lib/creator-auth/core";
import { CANVAS_TEMPLATE_ID, type Draft } from "./draft";
import { validateCanvas } from "@/lib/canvas/validate";
import { toInput, MAX_ACTIVE_DRAFTS, MAX_ARTIFACTS_PER_WALLET, type DraftView } from "./drafts-core";
import { IMAGE_EXT, sha256Hex, type ImageType } from "./image";
import { buildMetadata, checkUri } from "./metadata";
import { statusAfterEdit, type DraftState } from "./lifecycle";

export const BUCKET = "launch-assets";
const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
const fail = (e: unknown) => { if (e) throw new Error("launch_store_unavailable"); };

export class Conflict extends Error { constructor(public code: string) { super(code); } }


const BASE_COLS = "id, revision, status, chain_status, template_id, settings, product_name, tool_description, token_name, symbol, description, link, buy_preference, artwork_id, metadata_id, updated_at";
// Canvas storage (migration 0023, applied) is on. MCPX_CANVAS_DRAFTS=0 is an emergency stop that refuses
// Canvas drafts while every other draft keeps working unchanged.
export const canvasStorageEnabled = () => process.env["MCPX_CANVAS_DRAFTS"] !== "0";
const cols = () => (canvasStorageEnabled() ? `${BASE_COLS}, canvas_config` : BASE_COLS) as typeof BASE_COLS;
type Row = { id: string; revision: number; status: string; template_id: string; settings: unknown; product_name: string; tool_description: string | null; token_name: string; symbol: string; description: string; link: string | null; buy_preference: unknown; canvas_config?: unknown; artwork_id: string | null; metadata_id: string | null; updated_at: string };

function rowDraft(r: Row): Draft {
  const t = TEMPLATES.find((x) => x.id === r.template_id);
  return {
    templateId: r.template_id, templateName: t?.name ?? r.template_id, settings: (r.settings ?? {}) as Record<string, string>,
    productName: r.product_name, toolDescription: r.tool_description || null, tokenName: r.token_name, symbol: r.symbol, description: r.description, link: r.link,
    initialBuy: (r.buy_preference ?? null) as Draft["initialBuy"],
    // Re-validated on read: a stored config that no longer matches the catalog comes back as null and must be rebuilt.
    canvas: r.template_id === CANVAS_TEMPLATE_ID ? (() => { const c = validateCanvas(r.canvas_config); return c.ok ? c.config : null; })() : null,
  };
}

async function view(rows: Row[]): Promise<DraftView[]> {
  const ids = rows.flatMap((r) => [r.artwork_id, r.metadata_id]).filter((x): x is string => !!x);
  const arts = new Map<string, { public_url: string; width: number | null; height: number | null; bytes: number; content_type: string; sha256: string }>();
  if (ids.length) {
    const db = await admin();
    const { data, error } = await db.from("mcpx_launch_artifacts").select("id, public_url, width, height, bytes, content_type, sha256").in("id", ids);
    fail(error);
    for (const a of data ?? []) arts.set(a.id, a);
  }
  return rows.map((r) => {
    const a = r.artwork_id ? arts.get(r.artwork_id) : undefined;
    const m = r.metadata_id ? arts.get(r.metadata_id) : undefined;
    return {
      id: r.id, revision: r.revision, status: r.status as DraftState, chainStatus: "NOT_STARTED", input: toInput(rowDraft(r)),
      artwork: a ? { url: a.public_url, width: a.width ?? 0, height: a.height ?? 0, bytes: a.bytes, type: a.content_type, sha256: a.sha256 } : null,
      metadata: m ? { url: m.public_url, sha256: m.sha256 } : null,
      updatedAt: r.updated_at,
    };
  });
}

const fields = (d: Draft) => ({
  template_id: d.templateId, template_version: 1, settings: d.settings, product_name: d.productName, tool_description: d.toolDescription ?? "", token_name: d.tokenName,
  symbol: d.symbol, description: d.description, link: d.link, buy_preference: d.initialBuy,
});
/** Canvas column patch; only sent once storage is enabled. Typed loosely because generated types predate 0023. */
function canvasPatch(d: Draft): Record<string, never> {
  if (!canvasStorageEnabled()) { if (d.canvas) throw new Conflict("canvas_storage_unavailable"); return {}; }
  return { canvas_config: d.canvas } as unknown as Record<string, never>;
}

export async function listDrafts(wallet: string) {
  const db = await admin();
  const { data, error } = await db.from("mcpx_launch_drafts").select(cols()).eq("creator_wallet", wallet).neq("status", "ABANDONED").order("updated_at", { ascending: false }).limit(MAX_ACTIVE_DRAFTS);
  fail(error);
  return view((data ?? []) as Row[]);
}

export async function getDraft(wallet: string, id: string): Promise<DraftView | null> {
  const db = await admin();
  const { data, error } = await db.from("mcpx_launch_drafts").select(cols()).eq("creator_wallet", wallet).eq("id", id).neq("status", "ABANDONED").maybeSingle();
  fail(error);
  return data ? (await view([data as Row]))[0]! : null;
}

/** Idempotent on (wallet, createKey): a retried create returns the same draft. */
export async function createDraft(wallet: string, createKey: string, d: Draft): Promise<DraftView> {
  const db = await admin();
  const existing = await db.from("mcpx_launch_drafts").select(cols()).eq("creator_wallet", wallet).eq("create_key", createKey).maybeSingle();
  fail(existing.error);
  if (existing.data) return (await view([existing.data as Row]))[0]!;
  const { count, error: ce } = await db.from("mcpx_launch_drafts").select("id", { count: "exact", head: true }).eq("creator_wallet", wallet).neq("status", "ABANDONED");
  fail(ce);
  if ((count ?? 0) >= MAX_ACTIVE_DRAFTS) throw new Conflict("too_many_drafts");
  const { data, error } = await db.from("mcpx_launch_drafts").insert({ creator_wallet: wallet, create_key: createKey, ...fields(d), ...canvasPatch(d) }).select(cols()).single();
  if (error?.code === "23505") return createDraft(wallet, createKey, d);
  fail(error);
  return (await view([data as Row]))[0]!;
}

/** Optimistic concurrency: only the given revision can be changed. */
async function bump(wallet: string, id: string, revision: number, patch: Record<string, unknown>): Promise<DraftView> {
  const db = await admin();
  const { data, error } = await db.from("mcpx_launch_drafts").update({ ...patch, revision: revision + 1, updated_at: new Date().toISOString() })
    .eq("creator_wallet", wallet).eq("id", id).eq("revision", revision).neq("status", "ABANDONED").select(cols());
  fail(error);
  if (data?.[0]) return (await view([data[0] as Row]))[0]!;
  const cur = await getDraft(wallet, id);
  throw new Conflict(cur ? "stale_revision" : "not_found");
}

export async function updateDraft(wallet: string, id: string, revision: number, d: Draft) {
  const cur = await getDraft(wallet, id);
  if (!cur) throw new Conflict("not_found");
  // Any edit drops prepared metadata; it is never reused for a different draft revision.
  return bump(wallet, id, revision, { ...fields(d), ...canvasPatch(d), metadata_id: null, status: statusAfterEdit(!!cur.artwork) });
}

export async function abandonDraft(wallet: string, id: string, revision: number) {
  await bump(wallet, id, revision, { status: "ABANDONED", abandoned_at: new Date().toISOString(), metadata_id: null });
}

async function artifactCount(wallet: string) {
  const db = await admin();
  const { count, error } = await db.from("mcpx_launch_artifacts").select("id", { count: "exact", head: true }).eq("creator_wallet", wallet);
  fail(error);
  return count ?? 0;
}

export const assetUrl = (origin: string, path: string) => `${origin}/api/public/launch-assets/${path}`;

/** Store validated artwork under a fresh random immutable path, then attach it (new revision). */
export async function saveArtwork(wallet: string, origin: string, id: string, revision: number, bytes: Uint8Array, img: { type: ImageType; width: number; height: number }) {
  const cur = await getDraft(wallet, id);
  if (!cur) throw new Conflict("not_found");
  if (cur.revision !== revision) throw new Conflict("stale_revision");
  const hash = await sha256Hex(bytes);
  if (cur.artwork?.sha256 === hash) return cur; // same image retried: no new object, no new revision
  if ((await artifactCount(wallet)) >= MAX_ARTIFACTS_PER_WALLET) throw new Conflict("storage_limit");
  const db = await admin();
  const path = `artwork/${crypto.randomUUID()}.${IMAGE_EXT[img.type]}`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: img.type, upsert: false, cacheControl: "31536000" });
  fail(up.error);
  // Storage copy stays the integrity source; the public URL is IPFS when Pinata accepts it.
  const { pinBytes } = await import("./pinata.server");
  const url = (await pinBytes(bytes, path.split("/")[1]!, img.type)) ?? assetUrl(origin, path);
  if (!checkUri(url).ok) throw new Conflict("uri_too_long");
  const { data: art, error } = await db.from("mcpx_launch_artifacts").insert({
    creator_wallet: wallet, draft_id: id, draft_revision: revision + 1, kind: "artwork", object_path: path, public_url: url,
    sha256: hash, content_type: img.type, bytes: bytes.length, width: img.width, height: img.height,
  }).select("id").single();
  fail(error);
  return bump(wallet, id, revision, { artwork_id: art!.id, metadata_id: null, status: "ARTWORK_SAVED" });
}

/** Generated at review time from the exact saved revision; reused only for that same revision. */
export async function prepareMetadata(wallet: string, origin: string, id: string, revision: number) {
  const db = await admin();
  const { data: row, error } = await db.from("mcpx_launch_drafts").select(cols()).eq("creator_wallet", wallet).eq("id", id).neq("status", "ABANDONED").maybeSingle();
  fail(error);
  if (!row) throw new Conflict("not_found");
  const r = row as Row;
  if (r.revision !== revision) throw new Conflict("stale_revision");
  const cur = (await view([r]))[0]!;
  if (cur.metadata) return cur;
  if (!cur.artwork) throw new Conflict("artwork_required");
  const { json } = buildMetadata(rowDraft(r), cur.artwork.url);
  const bytes = new TextEncoder().encode(json);
  const hash = await sha256(json);
  const dup = await db.from("mcpx_launch_artifacts").select("id").eq("draft_id", id).eq("kind", "metadata").eq("sha256", hash).eq("draft_revision", revision).maybeSingle();
  fail(dup.error);
  let metaId = dup.data?.id;
  if (!metaId) {
    if ((await artifactCount(wallet)) >= MAX_ARTIFACTS_PER_WALLET) throw new Conflict("storage_limit");
    const path = `metadata/${crypto.randomUUID()}.json`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "application/json", upsert: false, cacheControl: "31536000" });
    fail(up.error);
    const { pinBytes } = await import("./pinata.server");
    const url = (await pinBytes(bytes, path.split("/")[1]!, "application/json")) ?? assetUrl(origin, path);
    if (!checkUri(url).ok) throw new Conflict("uri_too_long");
    const ins = await db.from("mcpx_launch_artifacts").insert({
      creator_wallet: wallet, draft_id: id, draft_revision: revision, kind: "metadata", object_path: path, public_url: url,
      sha256: hash, content_type: "application/json", bytes: bytes.length,
    }).select("id").single();
    fail(ins.error);
    metaId = ins.data!.id;
  }
  // Same revision (metadata doesn't change the draft's content); a concurrent edit makes this fail.
  const { data, error: ue } = await db.from("mcpx_launch_drafts").update({ metadata_id: metaId, status: "READY_FOR_FUTURE_PREPARATION", updated_at: new Date().toISOString() })
    .eq("creator_wallet", wallet).eq("id", id).eq("revision", revision).select(cols());
  fail(ue);
  if (!data?.[0]) throw new Conflict("stale_revision");
  return (await view([data[0] as Row]))[0]!;
}

/** Public read of a recorded artifact only; content type from the validated record. */
/** Resolve a recorded IPFS gateway URL back to its storage path (hash re-checked by readArtifact). */
export async function pathForPublicUrl(url: string): Promise<string | null> {
  const db = await admin();
  const { data, error } = await db.from("mcpx_launch_artifacts").select("object_path").eq("public_url", url).limit(1).maybeSingle();
  fail(error);
  return data?.object_path ?? null;
}

export async function readArtifact(path: string) {
  const db = await admin();
  const { data, error } = await db.from("mcpx_launch_artifacts").select("content_type, sha256").eq("object_path", path).maybeSingle();
  fail(error);
  if (!data) return null;
  const f = await db.storage.from(BUCKET).download(path);
  if (f.error || !f.data) throw new Error("launch_store_unavailable");
  const bytes = new Uint8Array(await f.data.arrayBuffer());
  if ((await sha256Hex(bytes)) !== data.sha256) throw new Error("integrity_mismatch");
  return { bytes, contentType: data.content_type, sha256: data.sha256 };
}

/** Per-wallet + global budgets ("launch:*"), separate from tool and auth budgets. Fails closed. */
export async function takeLaunchBudget(wallet: string, kind: "save" | "upload"): Promise<boolean> {
  const w = (await sha256(`launch:${wallet}`)).slice(0, 32);
  const limits = kind === "upload"
    ? [[`launch:up:h:${w}`, 3600, 20], ["launch:up:global", 3600, 300]] as const
    : [[`launch:save:m:${w}`, 60, 20], [`launch:save:h:${w}`, 3600, 200], ["launch:save:global", 60, 300]] as const;
  try {
    const db = await admin();
    for (const [bucket, window, limit] of limits) {
      const { data: ok, error } = await db.rpc("mcpx_rate_limit_take", { _bucket: bucket, _window_seconds: window, _limit: limit });
      if (error || ok !== true) return false;
    }
    return true;
  } catch { return false; }
}
