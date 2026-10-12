// Browser- and server-safe contract for Supply Monitor v1. No secrets here.
export const SM_SCHEMA = "mcpx.tool-execution.supply-monitor.v1";
export const SM_TOOL_ID = "supply_monitor";
export const SM_ENDPOINT = "/api/tools/supply-monitor";
export const SM_CLIENT_TIMEOUT_MS = 30_000;

export interface LargestAccount { address: string; raw: string; ui: string; sharePct: string | null }
export interface SupplyMonitorResult {
  schema: typeof SM_SCHEMA;
  executionId: string;
  toolId: typeof SM_TOOL_ID;
  network: "solana-mainnet";
  commitment: string;
  mint: string;
  observedAt: string;
  accountSlot: number;
  status: "mint" | "not_found" | "not_token_program" | "not_a_mint" | "unparsed";
  program: "spl-token" | "token-2022" | null;
  decimals: number | null;
  supply: { raw: string; ui: string; slot: number } | null;
  distribution: {
    status: "ok" | "unavailable"; reason: string | null; slot: number | null; accounts: LargestAccount[];
    returnedTotalRaw: string | null; returnedTotalUi: string | null; returnedSharePct: string | null;
  } | null;
  sameSlot?: boolean;
  partial?: boolean;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === null || isStr(v);
const slot = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const digits = (v: unknown) => isStr(v) && /^\d{1,21}$/.test(v);
const pct = (v: unknown) => v === null || (isStr(v) && /^\d{1,3}(\.\d{1,4})?$/.test(v));

/** Strict shape check of the worker response before it reaches the browser. */
export function isSupplyMonitorResult(v: unknown, mint: string): v is SupplyMonitorResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (!(r["schema"] === SM_SCHEMA && r["toolId"] === SM_TOOL_ID && r["network"] === "solana-mainnet" && r["mint"] === mint
    && isStr(r["executionId"]) && isStr(r["observedAt"]) && !Number.isNaN(Date.parse(r["observedAt"] as string)) && slot(r["accountSlot"])
    && ["mint", "not_found", "not_token_program", "not_a_mint", "unparsed"].includes(r["status"] as string)
    && [null, "spl-token", "token-2022"].includes(r["program"] as string))) return false;
  if (r["status"] !== "mint") return r["supply"] === null && r["distribution"] === null && r["decimals"] === null;
  const s = r["supply"] as Record<string, unknown> | null;
  const d = r["distribution"] as Record<string, unknown> | null;
  if (!Number.isInteger(r["decimals"]) || !s || !digits(s["raw"]) || !isStr(s["ui"]) || !slot(s["slot"])) return false;
  if (!d || !["ok", "unavailable"].includes(d["status"] as string) || !optStr(d["reason"]) || typeof r["sameSlot"] !== "boolean" || typeof r["partial"] !== "boolean") return false;
  const acc = d["accounts"];
  if (!Array.isArray(acc) || acc.length > 20 || !acc.every((a: Record<string, unknown>) => isStr(a["address"]) && digits(a["raw"]) && isStr(a["ui"]) && pct(a["sharePct"]))) return false;
  if (d["status"] === "ok") return slot(d["slot"]) && digits(d["returnedTotalRaw"]) && isStr(d["returnedTotalUi"]) && pct(d["returnedSharePct"]) && r["partial"] === false;
  return acc.length === 0 && r["partial"] === true;
}
