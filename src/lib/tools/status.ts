import { queryOptions } from "@tanstack/react-query";
import { WI_ENDPOINT } from "./wallet-inspector";

export interface ToolStatus { available: boolean; reason?: string; limits?: { perVisitorPerMinute: number; perVisitorPerHour: number; globalPerMinute: number } }

// One availability check per 5 minutes at most; never on focus, never polling, never wallet-keyed.
export const walletInspectorStatusQuery = queryOptions({
  queryKey: ["tool-status", "wallet_inspector"],
  queryFn: async (): Promise<ToolStatus> => {
    const r = await fetch(WI_ENDPOINT, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return { available: false, reason: "status_error" };
    return (await r.json()) as ToolStatus;
  },
  staleTime: 5 * 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
});
