import { createServerFn } from "@tanstack/react-start";
import { queryOptions } from "@tanstack/react-query";
import type { MarketSnapshot } from "./treasury/core";

export type TokenMarketResult = { status: "ok"; market: MarketSnapshot | null } | { status: "unavailable" } | { status: "not_found" };

// Public read keyed by product slug — the mint is resolved server-side from the verified registry,
// so callers can't spend the market-data quota on arbitrary tokens.
export const getTokenMarket = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => ({ slug: String(d?.slug ?? "").slice(0, 80) }))
  .handler(async ({ data }): Promise<TokenMarketResult> => {
    const { loadProfile } = await import("./product-profile");
    const { productionProfileDeps } = await import("./product-profile.server");
    const r = await loadProfile(productionProfileDeps, data.slug);
    if (r.status !== "ok") return { status: r.status };
    const { fetchMarket } = await import("./treasury/market.server");
    try { return { status: "ok", market: await fetchMarket(r.profile.childMint) }; }
    catch { return { status: "unavailable" }; }
  });

export const tokenMarketQuery = (slug: string) =>
  queryOptions({
    queryKey: ["token-market", slug],
    queryFn: () => getTokenMarket({ data: { slug } }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
