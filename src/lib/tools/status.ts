import { queryOptions } from "@tanstack/react-query";
import { WI_ENDPOINT } from "./wallet-inspector";
import { TV_ENDPOINT } from "./transaction-verifier";
import { TS_ENDPOINT } from "./token-scanner";
import { SM_ENDPOINT } from "./supply-monitor";
import { WW_ENDPOINT } from "./whale-watch";
import { AC_ENDPOINT } from "./account-checker";
import { HI_ENDPOINT } from "./holder-intelligence";
import { TRA_ENDPOINT } from "./token-risk-analyst";
import { SMT_ENDPOINT } from "./smart-money-tracker";
import { ORB_ENDPOINT } from "./onchain-report";

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
export const supplyMonitorStatusQuery = statusQuery("supply_monitor", SM_ENDPOINT);
export const whaleWatchStatusQuery = statusQuery("whale_watch", WW_ENDPOINT);
export const accountCheckerStatusQuery = statusQuery("account_checker", AC_ENDPOINT);
export const holderIntelligenceStatusQuery = statusQuery("holder_intelligence", HI_ENDPOINT);
export const tokenRiskAnalystStatusQuery = statusQuery("token_risk_analyst", TRA_ENDPOINT);
export const smartMoneyTrackerStatusQuery = statusQuery("smart_money_tracker", SMT_ENDPOINT);
export const onchainReportStatusQuery = statusQuery("onchain_report_builder", ORB_ENDPOINT);

// Entertainment & Experimental AI tools: one status query per tool id, same caching rules.
import { AI_ENDPOINT } from "@/lib/ai-tools/defs";
export const aiToolStatusQuery = (toolId: string) => statusQuery(toolId, AI_ENDPOINT(toolId));
