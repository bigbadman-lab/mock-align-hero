// Browser- and server-safe contract for Smart Money Tracker v1. No secrets here.
import { isValidSolanaAddress } from "./wallet-inspector";

export const SMT_SCHEMA = "mcpx.tool-execution.smart-money-tracker.v1";
export const SMT_TOOL_ID = "smart_money_tracker";
export const SMT_ENDPOINT = "/api/tools/smart-money-tracker";
export const SMT_CLIENT_TIMEOUT_MS = 30_000;
export const SMT_MAX_WALLETS = 3;

export type Detail = "decoded" | "partial" | "failed_tx" | "unavailable" | "unsupported_version" | "budget" | "not_inspected";
export interface SmtSignature { signature: string; slot: number; blockTime: number | null; succeeded: boolean; detail: Detail }
export interface SmtTransfer { signature: string; slot: number; blockTime: number | null; from: string; to: string; lamports: string; sol: string; direction: "IN" | "OUT" | "SELF" }
export interface SmtWallet {
  address: string; status: "ok" | "unavailable"; reason: string | null;
  signatures: SmtSignature[]; transfers: SmtTransfer[];
  highlights: { signature: string; direction: string; sol: string; slot: number }[];
  counts: { signaturesSeen: number; failedTransactions: number; decoded: number; partiallyDecoded: number; unavailable: number; truncatedByBudget: number; notInspected: number; missingBlockTime: number };
  window: { newestSlot: number | null; oldestSlot: number | null; newestBlockTime: number | null; oldestBlockTime: number | null };
}
export interface SmartMoneyResult {
  schema: typeof SMT_SCHEMA; executionId: string; toolId: typeof SMT_TOOL_ID; network: "solana-mainnet"; commitment: "finalized";
  fetchedAt: string; wallets: SmtWallet[]; complete: boolean; rpcCalls: number;
  limits: { signaturesPerWallet: number; detailsPerWallet: number; highlightLamports: string; highlightSol: string }; scope: string;
}

/** Normalizes user input: trims, drops blanks, rejects invalid, duplicates or more than 3. */
export function parseWallets(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > SMT_MAX_WALLETS) return null;
  if (!v.every((a) => typeof a === "string" && isValidSolanaAddress(a))) return null;
  return new Set(v).size === v.length ? (v as string[]) : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const slot = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const DETAILS = ["decoded", "partial", "failed_tx", "unavailable", "unsupported_version", "budget", "not_inspected"];

export function isSmartMoneyResult(v: unknown, wallets: string[]): v is SmartMoneyResult {
  if (!isObj(v) || v["schema"] !== SMT_SCHEMA || v["toolId"] !== SMT_TOOL_ID || v["network"] !== "solana-mainnet" || v["commitment"] !== "finalized") return false;
  if (typeof v["executionId"] !== "string" || Number.isNaN(Date.parse(String(v["fetchedAt"]))) || typeof v["complete"] !== "boolean" || !Number.isInteger(v["rpcCalls"]) || (v["rpcCalls"] as number) > 18) return false;
  const w = v["wallets"];
  if (!Array.isArray(w) || w.length !== wallets.length) return false;
  return w.every((x, i) => isObj(x) && x["address"] === wallets[i] && ["ok", "unavailable"].includes(x["status"] as string)
    && Array.isArray(x["signatures"]) && x["signatures"].length <= 20
    && x["signatures"].every((s) => isObj(s) && typeof s["signature"] === "string" && slot(s["slot"]) && (s["blockTime"] === null || Number.isSafeInteger(s["blockTime"])) && DETAILS.includes(s["detail"] as string))
    && Array.isArray(x["transfers"]) && x["transfers"].length <= 200
    && x["transfers"].every((t) => isObj(t) && typeof t["lamports"] === "string" && /^\d{1,20}$/.test(t["lamports"] as string))
    && Array.isArray(x["highlights"]) && isObj(x["counts"]) && isObj(x["window"]));
}
