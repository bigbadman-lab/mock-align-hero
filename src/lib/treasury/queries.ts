// One data layer for the home module and /treasury so the numbers can never disagree.
// Polls only while the tab is visible (react-query pauses hidden tabs), keeps last good data on errors.
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { ChildEcosystem, DistributionRow, Mode, Overview, WindowRow } from "./core";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error("treasury_unavailable");
  return (await r.json()) as T;
}
const common = { refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: false, retry: 1, staleTime: 20_000, placeholderData: keepPreviousData } as const;

export const overviewQuery = queryOptions({ queryKey: ["treasury", "overview"], queryFn: () => get<Overview>("/api/public/treasury/overview"), ...common });
export const childQuery = queryOptions({ queryKey: ["treasury", "child"], queryFn: () => get<ChildEcosystem>("/api/public/treasury/child-ecosystem"), ...common, refetchInterval: 60_000 });
export const windowsQuery = (range: "24h" | "7d" | "all") =>
  queryOptions({ queryKey: ["treasury", "windows", range], queryFn: () => get<{ mode: Mode; rows: WindowRow[]; next: string | null }>(`/api/public/treasury/windows?range=${range}`), ...common });
export const distributionsQuery = (p: { asset?: "SOL" | "MCP" | undefined; wallet?: string | undefined; beforeSlot?: number | undefined }) => {
  const s = new URLSearchParams();
  if (p.asset) s.set("asset", p.asset);
  if (p.wallet) s.set("wallet", p.wallet);
  if (p.beforeSlot) s.set("beforeSlot", String(p.beforeSlot));
  return queryOptions({ queryKey: ["treasury", "dist", p.asset ?? "", p.wallet ?? "", p.beforeSlot ?? 0],
    queryFn: () => get<{ mode: Mode; rows: DistributionRow[]; nextBeforeSlot: number | null }>(`/api/public/treasury/distributions?${s}`), ...common, refetchInterval: p.beforeSlot ? false : 30_000 });
};
