// Server-only reads for the creator dashboard. Every function is scoped by the session wallet's verified products.
import { siteRpcUrl } from "@/lib/solana-rpc.server";
import {
  ACTIVITY_PAGE, ACTIVITY_RETENTION_DAYS, EARNINGS_PAGE, EARNINGS_TOTALS_SCAN, WSOL_MINT,
  parseMintDecimals, resolveQuoteAsset,
  type ActivityRow, type CfIntentRow, type ChildRow, type OwnedProduct, type QuoteAsset,
} from "./core";

const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
// 0026 table is not in generated types until applied; minimal untyped view.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = { from(t: string): any; rpc(fn: string, args: Record<string, unknown>): any };

export async function ownedProducts(wallet: string): Promise<OwnedProduct[]> {
  const { data, error } = await (await admin()).from("mcp_creations").select("id, slug, display_name, child_mint, verified_at")
    .eq("creator_wallet", wallet).order("verified_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).map((r) => ({ creationId: r.id, slug: r.slug, name: r.display_name, childMint: r.child_mint, verifiedAt: r.verified_at }));
}

export async function childrenFor(mints: string[]): Promise<ChildRow[]> {
  const { data, error } = await (await admin()).from("mcpx_cf_children").select("mint, quote_mint, creator_wallet").in("mint", mints);
  if (error) throw error;
  return (data ?? []) as ChildRow[];
}

const COLS = "idempotency_key, mint, status, action, signature, finalized_slot, distributed_amount, updated_at";

/** Confirmed payouts in cursor order (finalized_slot desc, key asc); returns pageSize+1 to detect more. */
export async function confirmedPage(mints: string[], cursor: { slot: number; key: string } | null, pageSize = EARNINGS_PAGE): Promise<CfIntentRow[]> {
  let q = (await admin()).from("mcpx_cf_intents").select(COLS).in("mint", mints).eq("status", "LANDED")
    .not("finalized_slot", "is", null).not("signature", "is", null);
  if (cursor) q = q.or(`finalized_slot.lt.${cursor.slot},and(finalized_slot.eq.${cursor.slot},idempotency_key.gt."${cursor.key}")`);
  const { data, error } = await q.order("finalized_slot", { ascending: false }).order("idempotency_key", { ascending: true }).limit(pageSize + 1);
  if (error) throw error;
  return (data ?? []) as CfIntentRow[];
}

export async function totalsScan(mints: string[]): Promise<CfIntentRow[]> {
  const { data, error } = await (await admin()).from("mcpx_cf_intents").select(COLS).in("mint", mints).eq("status", "LANDED")
    .not("finalized_slot", "is", null).order("finalized_slot", { ascending: false }).limit(EARNINGS_TOTALS_SCAN);
  if (error) throw error;
  return (data ?? []) as CfIntentRow[];
}

export async function pendingCount(mints: string[]): Promise<number> {
  const { count, error } = await (await admin()).from("mcpx_cf_intents").select("idempotency_key", { count: "exact", head: true })
    .in("mint", mints).in("status", ["RESERVED", "SIGNED"]);
  if (error) throw error;
  return count ?? 0;
}

const decCache = new Map<string, { d: number | null; at: number }>();
async function mintDecimals(mint: string): Promise<number | null> {
  const hit = decCache.get(mint);
  if (hit && Date.now() - hit.at < (hit.d === null ? 60_000 : 3_600_000)) return hit.d;
  let d: number | null = null;
  try {
    const r = await fetch(siteRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed", commitment: "finalized" }] }) });
    if (r.ok) d = parseMintDecimals(((await r.json()) as { result?: { value?: unknown } }).result?.value ?? null);
  } catch { d = null; }
  decCache.set(mint, { d, at: Date.now() });
  return d;
}

/** Quote-asset identity for each mint: symbol only when verified, decimals only from chain (or wSOL constant). */
export async function quoteAssets(quoteMints: string[], officialMint: string | null): Promise<Record<string, QuoteAsset>> {
  const uniq = [...new Set(quoteMints)].slice(0, 20);
  const on = new Map<string, number>();
  await Promise.all(uniq.filter((m) => m !== WSOL_MINT).map(async (m) => { const d = await mintDecimals(m); if (d !== null) on.set(m, d); }));
  return Object.fromEntries(uniq.map((m) => [m, resolveQuoteAsset(m, officialMint, on)]));
}

export async function activityPage(creationIds: string[], cursor: { at: string; id: number } | null, pageSize = ACTIVITY_PAGE): Promise<ActivityRow[]> {
  const db = (await admin()) as unknown as Untyped;
  const since = new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
  let q = db.from("mcpx_tool_activity").select("id, creation_id, tool_id, outcome, occurred_at").in("creation_id", creationIds).gte("occurred_at", since);
  if (cursor) q = q.or(`occurred_at.lt."${cursor.at}",and(occurred_at.eq."${cursor.at}",id.lt.${cursor.id})`);
  const { data, error } = await q.order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize + 1);
  if (error) throw error;
  return (data ?? []) as ActivityRow[];
}

export async function recordActivity(e: { creationId: string; toolId: string; outcome: "ok" | "error"; ref: string }): Promise<void> {
  const db = (await admin()) as unknown as Untyped;
  const { error } = await db.rpc("mcpx_tool_activity_record", { _creation: e.creationId, _tool: e.toolId, _outcome: e.outcome, _ref: e.ref });
  if (error) throw new Error("activity_record_failed");
}
