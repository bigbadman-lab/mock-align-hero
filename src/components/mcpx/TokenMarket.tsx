import { useQuery } from "@tanstack/react-query";
import { tokenMarketQuery } from "@/lib/token-market.functions";
import { formatUsd } from "@/lib/treasury/core";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="label-mono text-subtle">{label}</div>
      <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

export function TokenMarket({ slug }: { slug: string }) {
  const { data, isPending } = useQuery(tokenMarketQuery(slug));
  const m = data?.status === "ok" ? data.market : null;
  const note = isPending ? "Loading market data…"
    : data?.status !== "ok" ? "Market data provider unavailable — values hidden, not zero."
    : !m ? "No market found for this exact mint yet."
    : `Source: ${m.source === "birdeye" ? "Birdeye" : "DexScreener"} · USD · refreshes every 30s · fetched ${new Date(m.fetchedAt).toUTCString().slice(17, 25)} UTC`;
  return (
    <section aria-labelledby="market-h" className="rounded-lg border border-border bg-card p-6">
      <h2 id="market-h" className="mb-4 text-lg font-semibold">Market</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Price" value={m?.priceUsd ? `$${Number(m.priceUsd).toPrecision(4)}` : "—"} />
        <Stat label="Market cap" value={m?.marketCapUsd != null ? formatUsd(m.marketCapUsd) : "—"} />
        <Stat label="FDV" value={m?.fdvUsd != null ? formatUsd(m.fdvUsd) : "—"} />
        <Stat label="24h volume" value={m?.volume24hUsd != null ? formatUsd(m.volume24hUsd) : "—"} />
        <Stat label="Liquidity" value={m?.liquidityUsd != null ? formatUsd(m.liquidityUsd) : "—"} />
        <Stat label="Holders" value={m?.holders != null ? m.holders.toLocaleString() : "—"} />
      </div>
      <p className="mt-3 text-[11px] text-subtle">{note}</p>
    </section>
  );
}
