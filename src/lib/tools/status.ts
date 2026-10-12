import { queryOptions } from "@tanstack/react-query";
import { WI_ENDPOINT } from "./wallet-inspector";
import { TV_ENDPOINT } from "./transaction-verifier";
import { TS_ENDPOINT } from "./token-scanner";

export interface ToolStatus { available: boolean; reason?: string; limits?: { perVisitorPerMinute: number; perVisitorPerHour: number; globalPerMinute: number } }

// One availability check per 5 minutes at most; never on focus, never polling, never wallet-keyed.
const statusQuery = (toolId: string, endpoint: string) => queryOptions({
  queryKey: ["tool-status", toolId],
  queryFn: async (): Promise<ToolStatus> => {
    const r = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return { available: false, reason: "status_error" };
    return (await r.json()) as ToolStatus;
  },
  staleTime: 5 * 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
});

export const walletInspectorStatusQuery = statusQuery("wallet_inspector", WI_ENDPOINT);
export const transactionVerifierStatusQuery = statusQuery("transaction_verifier", TV_ENDPOINT);
export const tokenScannerStatusQuery = statusQuery("token_scanner", TS_ENDPOINT);
