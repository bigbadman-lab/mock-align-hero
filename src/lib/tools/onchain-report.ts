// Browser- and server-safe contract for Onchain Report Builder v1. No secrets here.
import { isValidSolanaAddress } from "./wallet-inspector";

export const ORB_SCHEMA = "mcpx.tool-execution.onchain-report.v1";
export const ORB_TOOL_ID = "onchain_report_builder";
export const ORB_ENDPOINT = "/api/tools/onchain-report-builder";
export const ORB_CLIENT_TIMEOUT_MS = 30_000;
export type TargetType = "wallet" | "token";
export const COMPONENTS: Record<TargetType, string[]> = { wallet: ["wallet_inspector", "account_checker"], token: ["token_scanner", "supply_monitor"] };

export interface ReportComponent { tool: string; schema: string; required: boolean; status: "ok" | "partial" | "failed"; error: string | null }
export interface ReportFinding { id: string; text: string; evidence: string | null }
export interface OnchainReport {
  schema: typeof ORB_SCHEMA; executionId: string; toolId: typeof ORB_TOOL_ID; network: "solana-mainnet";
  targetType: TargetType; target: string; generatedAt: string; status: "complete" | "partial";
  components: ReportComponent[]; findings: ReportFinding[];
  holdings?: { mint: string; amountUi: string; tokenAccounts: number }[];
  limitations: string[]; usage: { rpcCalls: number; callBudget: number; ms: number };
}

export const isTargetType = (v: unknown): v is TargetType => v === "wallet" || v === "token";
export const validTarget = (t: unknown, a: unknown) => isTargetType(t) && typeof a === "string" && isValidSolanaAddress(a);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function isOnchainReport(v: unknown, targetType: TargetType, target: string): v is OnchainReport {
  if (!isObj(v) || v["schema"] !== ORB_SCHEMA || v["toolId"] !== ORB_TOOL_ID || v["network"] !== "solana-mainnet" || v["targetType"] !== targetType || v["target"] !== target) return false;
  if (typeof v["executionId"] !== "string" || Number.isNaN(Date.parse(String(v["generatedAt"])))) return false;
  const c = v["components"], f = v["findings"], u = v["usage"], l = v["limitations"];
  if (!Array.isArray(c) || c.map((x) => (isObj(x) ? x["tool"] : null)).join(",") !== COMPONENTS[targetType].join(",")) return false;
  if (!c.every((x) => isObj(x) && ["ok", "partial", "failed"].includes(x["status"] as string))) return false;
  const anyNotOk = c.some((x) => (x as Record<string, unknown>)["status"] !== "ok");
  if (v["status"] !== (anyNotOk ? "partial" : "complete")) return false; // a partial report can never read as complete
  if ((c as ReportComponent[]).some((x) => x.required && x.status === "failed")) return false; // required failure must fail closed
  if (!Array.isArray(f) || f.length > 12 || !f.every((x) => isObj(x) && typeof x["text"] === "string" && (x["text"] as string).length <= 400)) return false;
  if (!Array.isArray(l) || (anyNotOk && !l.some((x) => typeof x === "string" && x.startsWith("PARTIAL")))) return false;
  return isObj(u) && Number.isInteger(u["rpcCalls"]) && (u["rpcCalls"] as number) <= 6;
}
