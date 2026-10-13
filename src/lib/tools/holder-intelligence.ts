// Browser- and server-safe contract for Holder Intelligence v1. No secrets here.
export const HI_SCHEMA = "mcpx.tool-execution.holder-intelligence.v1";
export const HI_TOOL_ID = "holder_intelligence";
export const HI_ENDPOINT = "/api/tools/holder-intelligence";
export const HI_CLIENT_TIMEOUT_MS = 30_000;

export type OwnerKind = "system_account" | "program_owned" | "no_account" | "unknown";
export interface HiAccount { address: string; raw: string; ui: string; sharePct: string | null; owner: string | null; ownerStatus: "resolved" | "missing" | "unresolved"; state: "initialized" | "frozen" | null }
export interface HiOwner { owner: string; tokenAccounts: number; raw: string; ui: string; sharePct: string | null; ownerKind: OwnerKind; ownerProgram: string | null; onCurve: boolean | null }
export interface HiConcentration { denominator: string; largestAccountPct: string | null; top5AccountsPct: string | null; top10AccountsPct: string | null; top20AccountsPct: string | null; largestObservedOwnerPct: string | null }
export interface HiCoverage {
  population: "largest_token_accounts"; populationNote: string; maxAccounts: number; observedAccounts: number;
  observedRaw: string; observedUi: string; observedSharePct: string | null; ownersResolved: number; ownersUnresolved: number;
  ownerAggregationScope: string; completeHolderSet: false; uniqueHolderCount: null;
}
export interface TokenMetadata { status: "ok" | "none" | "unknown" | "not_read"; name: string | null; symbol: string | null; source: string | null }
export interface HolderIntelligenceResult {
  schema: typeof HI_SCHEMA; executionId: string; toolId: typeof HI_TOOL_ID; network: "solana-mainnet"; commitment: string;
  mint: string; observedAt: string; rpcCalls: number; methods: string[];
  status: "mint" | "not_found" | "not_token_program" | "not_a_mint" | "unparsed";
  program: "spl-token" | "token-2022" | null; decimals: number | null;
  supply: { raw: string; ui: string; slot: number } | null;
  metadata: TokenMetadata | null;
  distribution: { status: "ok" | "unavailable"; reason: string | null; accounts: HiAccount[]; owners: HiOwner[]; concentration: HiConcentration | null; coverage: HiCoverage | null } | null;
  slots: Record<string, number | null>;
  sameSlot?: boolean; partial: boolean; warnings: { part: string; kind: string }[];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const slot = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const digits = (v: unknown) => isStr(v) && /^\d{1,21}$/.test(v);
export const pct = (v: unknown) => v === null || (isStr(v) && /^\d{1,3}(\.\d{1,4})?$/.test(v));
const optAddr = (v: unknown) => v === null || (isStr(v) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v));
export const MINT_STATUSES = ["mint", "not_found", "not_token_program", "not_a_mint", "unparsed"];

/** Shared header check for both new tools. */
export function baseOk(r: Record<string, unknown>, schema: string, toolId: string, mint: string) {
  return r["schema"] === schema && r["toolId"] === toolId && r["network"] === "solana-mainnet" && r["mint"] === mint
    && isStr(r["executionId"]) && isStr(r["observedAt"]) && !Number.isNaN(Date.parse(r["observedAt"] as string))
    && Number.isInteger(r["rpcCalls"]) && (r["rpcCalls"] as number) <= 5 && Array.isArray(r["methods"])
    && MINT_STATUSES.includes(r["status"] as string) && [null, "spl-token", "token-2022"].includes(r["program"] as string)
    && isObj(r["slots"]) && Object.values(r["slots"] as object).every((s) => s === null || slot(s));
}

/** Strict shape check of the worker response before it reaches the browser or an MCP client. */
export function isHolderIntelligenceResult(v: unknown, mint: string): v is HolderIntelligenceResult {
  if (!isObj(v) || !baseOk(v, HI_SCHEMA, HI_TOOL_ID, mint) || typeof v["partial"] !== "boolean" || !Array.isArray(v["warnings"])) return false;
  if (v["status"] !== "mint") return v["supply"] === null && v["distribution"] === null;
  const s = v["supply"], d = v["distribution"];
  if (!Number.isInteger(v["decimals"]) || !isObj(s) || !digits(s["raw"]) || !isStr(s["ui"]) || !slot(s["slot"]) || !isObj(d)) return false;
  const acc = d["accounts"], own = d["owners"];
  if (!Array.isArray(acc) || acc.length > 20 || !Array.isArray(own) || own.length > 20) return false;
  if (!acc.every((a) => isObj(a) && isStr(a["address"]) && digits(a["raw"]) && pct(a["sharePct"]) && optAddr(a["owner"]) && ["resolved", "missing", "unresolved"].includes(a["ownerStatus"] as string))) return false;
  if (!own.every((o) => isObj(o) && isStr(o["owner"]) && digits(o["raw"]) && pct(o["sharePct"]) && Number.isInteger(o["tokenAccounts"]) && ["system_account", "program_owned", "no_account", "unknown"].includes(o["ownerKind"] as string))) return false;
  if (d["status"] === "ok") {
    const c = d["concentration"], cov = d["coverage"];
    return isObj(c) && ["largestAccountPct", "top5AccountsPct", "top10AccountsPct", "top20AccountsPct", "largestObservedOwnerPct"].every((k) => pct(c[k]))
      && isObj(cov) && cov["completeHolderSet"] === false && cov["uniqueHolderCount"] === null && cov["observedAccounts"] === acc.length;
  }
  return d["status"] === "unavailable" && acc.length === 0 && v["partial"] === true;
}
