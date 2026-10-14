// Token market data. Bounded, cached server fetch (never per visitor, never browser-side keys).
// Primary: Birdeye token_overview for the exact mint (BIRDEYE_API_KEY). Fallback: DexScreener public endpoint,
// using only pairs whose BASE token is exactly the mint — never ticker matches. FDV and market cap stay separate.
import type { MarketSnapshot } from "./core";

interface Pair { baseToken?: { address?: string }; priceUsd?: string; volume?: { h24?: number }; liquidity?: { usd?: number }; marketCap?: number; fdv?: number }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function pickMarket(mint: string, pairs: Pair[], fetchedAt: string): MarketSnapshot | null {
  const own = pairs.filter((p) => p.baseToken?.address === mint);
  if (!own.length) return null;
  const top = [...own].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]!;
  const vol = own.reduce((t, p) => t + (Number.isFinite(p.volume?.h24) ? p.volume!.h24! : 0), 0);
  return {
    source: "dexscreener", quote: "USD", priceUsd: typeof top.priceUsd === "string" ? top.priceUsd : null,
    volume24hUsd: vol, marketCapUsd: num(top.marketCap), fdvUsd: num(top.fdv),
    liquidityUsd: num(top.liquidity?.usd), holders: null,
    pairCount: own.length, fetchedAt,
  };
}

export function pickBirdeye(mint: string, body: unknown, fetchedAt: string): MarketSnapshot | null {
  const b = body as { success?: boolean; data?: Record<string, unknown> } | null;
  const d = b?.success ? b.data : null;
  if (!d || d["address"] !== mint) return null;
  const price = num(d["price"]);
  if (price == null) return null;
  return {
    source: "birdeye", quote: "USD", priceUsd: String(price),
    volume24hUsd: num(d["v24hUSD"]), marketCapUsd: num(d["marketCap"]), fdvUsd: num(d["fdv"]),
    liquidityUsd: num(d["liquidity"]), holders: num(d["holder"]),
    pairCount: num(d["numberMarkets"]) ?? 0, fetchedAt,
  };
}

async function fromBirdeye(mint: string): Promise<MarketSnapshot | null> {
  const key = process.env["BIRDEYE_API_KEY"];
  if (!key) throw new Error("no_key");
  const r = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
    signal: AbortSignal.timeout(5_000), headers: { accept: "application/json", "X-API-KEY": key, "x-chain": "solana" },
  });
  if (!r.ok) throw new Error("birdeye_unavailable");
  return pickBirdeye(mint, await r.json(), new Date().toISOString());
}

async function fromDex(mint: string): Promise<MarketSnapshot | null> {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("dex_unavailable");
  const body = (await r.json()) as unknown;
  return pickMarket(mint, Array.isArray(body) ? (body as Pair[]) : [], new Date().toISOString());
}

const MAX = 200;
const cache = new Map<string, { at: number; v: MarketSnapshot | null }>();
const inflight = new Map<string, Promise<MarketSnapshot | null>>();

export async function fetchMarket(mint: string): Promise<MarketSnapshot | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const running = inflight.get(mint);
  if (running) return running;
  const p = (async () => {
    let v: MarketSnapshot | null = null;
    let ok = false;
    try { v = await fromBirdeye(mint); ok = true; } catch { /* fall through */ }
    if (!v) { try { v = await fromDex(mint); ok = true; } catch { /* both failed */ } }
    if (!ok) { if (hit) return hit.v; throw new Error("market_unavailable"); }
    cache.delete(mint); cache.set(mint, { at: Date.now(), v });
    while (cache.size > MAX) cache.delete(cache.keys().next().value!);
    return v;
  })().finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}
