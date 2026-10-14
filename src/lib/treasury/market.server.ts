// Native $MCP market data. One bounded, cached server fetch (never per visitor, never browser RPC).
// Provider: DexScreener public token endpoint (no key). Only pairs whose BASE token is exactly the canonical
// mint are used — never ticker matches or child tokens. FDV and market cap are kept separate.
import type { MarketSnapshot } from "./core";

interface Pair { baseToken?: { address?: string }; priceUsd?: string; volume?: { h24?: number }; liquidity?: { usd?: number }; marketCap?: number; fdv?: number }

export function pickMarket(mint: string, pairs: Pair[], fetchedAt: string): MarketSnapshot | null {
  const own = pairs.filter((p) => p.baseToken?.address === mint);
  if (!own.length) return null;
  const top = [...own].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]!;
  const vol = own.reduce((t, p) => t + (Number.isFinite(p.volume?.h24) ? p.volume!.h24! : 0), 0);
  return {
    source: "dexscreener", quote: "USD", priceUsd: typeof top.priceUsd === "string" ? top.priceUsd : null,
    volume24hUsd: vol, marketCapUsd: Number.isFinite(top.marketCap) ? top.marketCap! : null, fdvUsd: Number.isFinite(top.fdv) ? top.fdv! : null,
    pairCount: own.length, fetchedAt,
  };
}

let last: { mint: string; at: number; v: MarketSnapshot | null } | null = null;
export async function fetchMarket(mint: string): Promise<MarketSnapshot | null> {
  if (last && last.mint === mint && Date.now() - last.at < 60_000) return last.v;
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!r.ok) { if (last?.mint === mint) return last.v; throw new Error("market_unavailable"); }
  const body = (await r.json()) as unknown;
  const v = pickMarket(mint, Array.isArray(body) ? (body as Pair[]) : [], new Date().toISOString());
  last = { mint, at: Date.now(), v };
  return v;
}
