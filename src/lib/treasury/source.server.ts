// TREASURY-01 public projection. Server-only: reads private ledger tables with the admin client and returns
// only sanitized, finalized fields (never signed bytes, messages, evidence bodies, leases or reservation data).
// Every read is bounded, namespaced to the configured mint/genesis window, and cached per isolate.
import {
  type ChildEcosystem, type DistributionRow, type IntentLike, type Mode, type Overview, type WindowRow,
  deriveWindowStatus, nextBoundary, payoutRows, sumRaw, windowLabel, B58,
} from "./core";
import { fetchMarket } from "./market.server";

type Admin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
const admin = async (): Promise<Admin> => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
const db = async () => (await admin()) as unknown as { from: (t: string) => any }; // ledger tables are typed loosely on purpose

const cache = new Map<string, { at: number; v: unknown; p?: Promise<unknown> }>();
/** Single-flight TTL cache: concurrent readers share one DB read per isolate. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  if (c?.p) return c.p as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }).finally(() => { const e = cache.get(key); if (e) delete e.p; });
  cache.set(key, { at: c?.at ?? 0, v: c?.v, p });
  return p;
}

interface Ns { mint: string | null; genesisIso: string | null; mode: Mode }
async function namespace(): Promise<Ns> {
  const { data } = await (await db()).from("mcpx_rw_config").select("mint, genesis_window").eq("id", 1).maybeSingle();
  const mint = data?.mint && B58.test(data.mint) ? (data.mint as string) : null;
  const genesisIso = data?.genesis_window ? new Date(Number(data.genesis_window) * 1000).toISOString() : null;
  const mode: Mode = !mint ? "PRELAUNCH" : process.env["MCPX_TREASURY_MODE"] === "rehearsal" ? "REHEARSAL" : "PRODUCTION";
  return { mint, genesisIso, mode };
}

const INTENT_COLS = "idempotency_key, kind, state, signature, finalized_slot, evidence, epoch_start, plan_rows, plan_mint, plan_token_program, batch_id, lamports, token_amount";

async function landedPayouts(ns: Ns, limit: number, beforeSlot?: number) {
  let q = (await db()).from("mcpx_rw_intents").select(INTENT_COLS).in("kind", ["SOL_PAYOUT", "TOKEN_PAYOUT"]).eq("state", "LANDED")
    .not("finalized_slot", "is", null).order("finalized_slot", { ascending: false }).limit(limit);
  if (ns.genesisIso) q = q.gte("epoch_start", ns.genesisIso);
  if (beforeSlot) q = q.lt("finalized_slot", beforeSlot);
  const { data, error } = await q;
  if (error) throw new Error("ledger_unavailable");
  return (data ?? []) as (IntentLike & { plan_token_program: string | null; lamports: string | null; token_amount: string | null })[];
}

async function tokenDecimals(ns: Ns): Promise<number | null> {
  if (!ns.mint) return null;
  const { data } = await (await db()).from("mcpx_rw_buyback_fills").select("decimals").eq("mint", ns.mint).limit(1).maybeSingle();
  return data?.decimals ?? null;
}

export async function getOverview(): Promise<Overview> {
  return cached("overview", 15_000, async () => {
    const d = await db();
    const ns = await namespace();
    const now = Date.now();
    const base = { mode: ns.mode, serverTime: new Date(now).toISOString(), asOf: new Date(now).toISOString(), mint: ns.mint, symbol: "$MCP" as const };
    const { data: st } = await d.from("mcpx_rw_proc_state").select("watermark, heartbeat_at").eq("id", 1).maybeSingle();
    const heartbeatAt = st?.heartbeat_at ?? null;
    if (!ns.mint) {
      return { ...base, tokenProgram: null, market: null, marketError: null, supply: null, holderCount: null, fees: null, allocation: null, paid: null, buyback: null,
        windows: { status: "NOT_LAUNCHED", nextBoundary: new Date(nextBoundary(now)).toISOString(), lastProcessed: null, lastProcessedOutcome: null, lastFinalizedPayout: null, heartbeatAt } };
    }
    const g = ns.genesisIso ?? "1970-01-01T00:00:00Z";
    const [fees, allocs, fills, snap, plan, payouts, decimals, market] = await Promise.all([
      d.from("mcpx_rw_fee_events").select("amount, slot").eq("mint", ns.mint).eq("status", "CREDITED").eq("commitment", "finalized").order("slot", { ascending: false }).limit(5000),
      d.from("mcpx_rw_allocations").select("holder_sol, buyback, operations").gte("epoch_start", g).limit(5000),
      d.from("mcpx_rw_buyback_fills").select("token_amount, sol_spent, decimals").eq("mint", ns.mint).not("finalized_slot", "is", null).limit(5000),
      d.from("mcpx_rw_hix_snapshots").select("slot, supply, holder_count, window_start").eq("mint", ns.mint).order("window_start", { ascending: false }).limit(1).maybeSingle(),
      d.from("mcpx_rw_window_plans").select("window_start, status").gte("window_start", g).order("window_start", { ascending: false }).limit(1).maybeSingle(),
      landedPayouts(ns, 500),
      tokenDecimals(ns),
      fetchMarket(ns.mint).then((m) => ({ m, e: null as string | null }), () => ({ m: null, e: "market_unavailable" })),
    ]);
    if (fees.error || allocs.error || fills.error) throw new Error("ledger_unavailable");
    const rows = payoutRows(payouts, { mint: ns.mint, tokenDecimals: decimals ?? 0 });
    const sol = rows.filter((r) => r.asset === "SOL"), tok = rows.filter((r) => r.asset === "MCP");
    const program = payouts.find((p) => p.plan_mint === ns.mint && p.plan_token_program)?.plan_token_program ?? null;
    const lastProcessed = plan.data?.window_start ? Date.parse(plan.data.window_start) : null;
    return {
      ...base,
      tokenProgram: program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "token-2022" : program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ? "spl-token" : null,
      market: market.m, marketError: market.e,
      supply: snap.data ? { raw: String(snap.data.supply), decimals, slot: Number(snap.data.slot), source: "frozen-holder-snapshot" } : null,
      holderCount: snap.data ? { count: Number(snap.data.holder_count), slot: Number(snap.data.slot), source: "frozen-holder-snapshot" } : null,
      fees: { collectedLamports: sumRaw((fees.data ?? []).map((f: any) => f.amount)), events: fees.data?.length ?? 0, lastSlot: fees.data?.[0]?.slot ?? null },
      allocation: { holderSolLamports: sumRaw((allocs.data ?? []).map((a: any) => a.holder_sol)), buybackLamports: sumRaw((allocs.data ?? []).map((a: any) => a.buyback)), operationsLamports: sumRaw((allocs.data ?? []).map((a: any) => a.operations)) },
      paid: { solLamports: sumRaw(sol.map((r) => r.amountRaw)), tokenRaw: sumRaw(tok.map((r) => r.amountRaw)), tokenDecimals: decimals, payouts: rows.length },
      buyback: { solSpentLamports: sumRaw((fills.data ?? []).map((f: any) => f.sol_spent)), tokenAcquiredRaw: sumRaw((fills.data ?? []).map((f: any) => f.token_amount)), fills: fills.data?.length ?? 0 },
      windows: {
        status: deriveWindowStatus({ mint: ns.mint, now, heartbeatAt: heartbeatAt ? Date.parse(heartbeatAt) : null, lastProcessedWindow: lastProcessed }),
        nextBoundary: new Date(nextBoundary(now)).toISOString(),
        lastProcessed: plan.data?.window_start ?? null, lastProcessedOutcome: plan.data?.status ?? null,
        lastFinalizedPayout: rows[0]?.windowStart ?? null, heartbeatAt,
      },
    };
  });
}

export async function getWindows(range: "24h" | "7d" | "all", before?: string): Promise<{ mode: Mode; rows: WindowRow[]; next: string | null }> {
  return cached(`windows:${range}:${before ?? ""}`, 15_000, async () => {
    const ns = await namespace();
    if (!ns.mint) return { mode: ns.mode, rows: [], next: null };
    const floor = range === "all" ? ns.genesisIso : new Date(Date.now() - (range === "24h" ? 864e5 : 7 * 864e5)).toISOString();
    let q = (await db()).from("mcpx_rw_window_plans").select("window_start, status, mode, hold_reasons, rewards_total, operations_total").order("window_start", { ascending: false }).limit(25);
    const g = [floor, ns.genesisIso].filter(Boolean).sort().pop();
    if (g) q = q.gte("window_start", g);
    if (before) q = q.lt("window_start", before);
    const { data, error } = await q;
    if (error) throw new Error("ledger_unavailable");
    const rows: WindowRow[] = (data ?? []).map((w: any) => {
      const holds = (w.hold_reasons ?? []) as string[];
      const rewards = String(w.rewards_total ?? "0");
      return { windowStart: w.window_start, status: w.status, mode: w.mode, holds, rewardsLamports: rewards, operationsLamports: String(w.operations_total ?? "0"), label: windowLabel(w.status, holds, rewards) };
    });
    return { mode: ns.mode, rows, next: rows.length === 25 ? rows[24]!.windowStart : null };
  });
}

export async function getDistributions(p: { asset?: "SOL" | "MCP"; wallet?: string; beforeSlot?: number }): Promise<{ mode: Mode; rows: DistributionRow[]; nextBeforeSlot: number | null }> {
  return cached(`dist:${p.asset ?? ""}:${p.wallet ?? ""}:${p.beforeSlot ?? ""}`, 15_000, async () => {
    const ns = await namespace();
    if (!ns.mint) return { mode: ns.mode, rows: [], nextBeforeSlot: null };
    const intents = await landedPayouts(ns, 20, p.beforeSlot);
    let rows = payoutRows(intents, { mint: ns.mint, tokenDecimals: (await tokenDecimals(ns)) ?? 0 });
    if (p.asset) rows = rows.filter((r) => r.asset === p.asset);
    if (p.wallet) rows = rows.filter((r) => r.recipient === p.wallet);
    const last = intents[intents.length - 1];
    return { mode: ns.mode, rows: rows.slice(0, 200), nextBeforeSlot: intents.length === 20 && last ? Number(last.finalized_slot) : null };
  });
}

export async function getChildEcosystem(): Promise<ChildEcosystem> {
  return cached("child", 30_000, async () => {
    const d = await db();
    const [products, dist] = await Promise.all([
      d.from("mcp_creations").select("id", { count: "exact", head: true }).not("verified_tx_signature", "is", null).not("verified_slot", "is", null),
      d.from("mcpx_cf_intents").select("distributed_amount, finalized_slot").eq("status", "LANDED").not("finalized_slot", "is", null).order("finalized_slot", { ascending: false }).limit(5000),
    ]);
    if (products.error || dist.error) throw new Error("ledger_unavailable");
    const rows = (dist.data ?? []) as { distributed_amount: string | null; finalized_slot: number }[];
    return { verifiedProducts: products.count ?? 0, distributions: rows.length, distributedRaw: rows.length ? sumRaw(rows.map((r) => r.distributed_amount)) : null, lastFinalizedSlot: rows[0]?.finalized_slot ?? null };
  });
}
