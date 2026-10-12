// Browser- and server-safe contract for Whale Watch v1. No secrets here.
export const WW_SCHEMA = "mcpx.tool-execution.whale-watch.v1";
export const WW_TOOL_ID = "whale_watch";
export const WW_ENDPOINT = "/api/tools/whale-watch";
export const WW_CLIENT_TIMEOUT_MS = 30_000;
export const WW_THRESHOLDS = [
  { lamports: "100000000", label: "0.1 SOL" },
  { lamports: "1000000000", label: "1 SOL" },
  { lamports: "10000000000", label: "10 SOL" },
  { lamports: "100000000000", label: "100 SOL" },
] as const;
export const WW_DEFAULT_THRESHOLD = "1000000000";
export const isValidThreshold = (v: unknown): v is string => WW_THRESHOLDS.some((t) => t.lamports === v);

export interface WhaleTransfer {
  signature: string; outerIndex: number; innerIndex: number | null; slot: number; blockTime: number | null;
  from: string; to: string; lamports: string; sol: string; direction: "IN" | "OUT" | "SELF";
}
export interface WhaleWatchCoverage {
  signaturesSeen: number; transactionsAttempted: number; transactionsDecoded: number; failedTransactions: number;
  unavailableTransactions: number; unsupportedVersion: number; partiallyDecoded: number; truncatedByBudget: number; notInspected: number;
}
export interface WhaleWatchResult {
  schema: typeof WW_SCHEMA; executionId: string; toolId: typeof WW_TOOL_ID; network: "solana-mainnet"; commitment: string;
  address: string; minLamports: string; minSol: string; fetchedAt: string; newestSlot: number | null; oldestInspectedSlot: number | null;
  coverage: WhaleWatchCoverage; complete: boolean; transfers: WhaleTransfer[];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const n = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nn = (v: unknown) => v === null || n(v);
const COV_KEYS = ["signaturesSeen", "transactionsAttempted", "transactionsDecoded", "failedTransactions", "unavailableTransactions", "unsupportedVersion", "partiallyDecoded", "truncatedByBudget", "notInspected"];

/** Strict shape check of the worker response before it reaches the browser. */
export function isWhaleWatchResult(v: unknown, address: string, minLamports: string): v is WhaleWatchResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const c = r["coverage"] as Record<string, unknown> | undefined;
  const t = r["transfers"];
  if (!(r["schema"] === WW_SCHEMA && r["toolId"] === WW_TOOL_ID && r["network"] === "solana-mainnet" && r["address"] === address && r["minLamports"] === minLamports
    && isStr(r["executionId"]) && isStr(r["fetchedAt"]) && !Number.isNaN(Date.parse(r["fetchedAt"] as string)) && isStr(r["minSol"])
    && nn(r["newestSlot"]) && nn(r["oldestInspectedSlot"]) && typeof r["complete"] === "boolean" && !!c && COV_KEYS.every((k) => n(c[k]))
    && (c["signaturesSeen"] as number) <= 20 && (c["transactionsAttempted"] as number) <= 10)) return false;
  if (!Array.isArray(t) || t.length > 200) return false;
  const min = BigInt(minLamports);
  return t.every((x: Record<string, unknown>) => isStr(x["signature"]) && n(x["outerIndex"]) && nn(x["innerIndex"]) && n(x["slot"]) && nn(x["blockTime"])
    && isStr(x["from"]) && isStr(x["to"]) && isStr(x["lamports"]) && /^\d{1,20}$/.test(x["lamports"] as string) && BigInt(x["lamports"] as string) >= min
    && isStr(x["sol"]) && ["IN", "OUT", "SELF"].includes(x["direction"] as string) && (x["from"] === address || x["to"] === address));
}
