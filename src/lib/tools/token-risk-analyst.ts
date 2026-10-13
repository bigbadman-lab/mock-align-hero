// Browser- and server-safe contract for Token Risk Analyst v1. No secrets here.
import { baseOk, pct, type TokenMetadata } from "./holder-intelligence";

export const TRA_SCHEMA = "mcpx.tool-execution.token-risk-analyst.v1";
export const TRA_TOOL_ID = "token_risk_analyst";
export const TRA_ENDPOINT = "/api/tools/token-risk-analyst";
export const TRA_CLIENT_TIMEOUT_MS = 30_000;

export type CheckState = "observed" | "not_observed" | "unknown" | "not_applicable";
export const CHECK_STATES: CheckState[] = ["observed", "not_observed", "unknown", "not_applicable"];
/** Plain-language meaning of each state, shown to users and documented for MCP clients. */
export const STATE_MEANING: Record<CheckState, string> = {
  observed: "Seen onchain at the queried state.",
  not_observed: "Checked and not present at the queried state.",
  unknown: "Could not be determined — not proof that it is absent.",
  not_applicable: "Does not apply to this token or this data.",
};
export const CHECK_IDS = [
  "mint_authority", "freeze_authority", "permanent_delegate", "transfer_hook", "transfer_fee", "default_frozen",
  "non_transferable", "pausable", "mint_close_authority", "undecoded_extensions", "largest_account_concentration", "top10_concentration",
] as const;

export interface CheckItem { id: (typeof CHECK_IDS)[number]; label: string; state: CheckState; evidence: string | null; meaning: string }
export interface TokenRiskResult {
  schema: typeof TRA_SCHEMA; executionId: string; toolId: typeof TRA_TOOL_ID; network: "solana-mainnet"; commitment: string;
  mint: string; observedAt: string; rpcCalls: number; methods: string[];
  status: "mint" | "not_found" | "not_token_program" | "not_a_mint" | "unparsed";
  program: "spl-token" | "token-2022" | null; decimals: number | null;
  supply: { raw: string; ui: string; slot: number } | null; metadata: TokenMetadata | null;
  checklist: CheckItem[];
  concentration: { largestAccountPct: string | null; top10AccountsPct: string | null; coverage: "largest_token_accounts"; observedAccounts: number } | null;
  thresholds?: { largestAccountPct: number; top10AccountsPct: number };
  summary: { observed: number; notObserved: number; unknown: number; notApplicable: number; complete: boolean; score: null } | null;
  slots: Record<string, number | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function isTokenRiskResult(v: unknown, mint: string): v is TokenRiskResult {
  if (!isObj(v) || !baseOk(v, TRA_SCHEMA, TRA_TOOL_ID, mint)) return false;
  if (v["status"] !== "mint") return v["supply"] === null && Array.isArray(v["checklist"]) && v["checklist"].length === 0 && v["summary"] === null;
  const list = v["checklist"], s = v["summary"], c = v["concentration"];
  if (!Array.isArray(list) || list.length !== CHECK_IDS.length) return false;
  if (!list.every((i, n) => isObj(i) && i["id"] === CHECK_IDS[n] && typeof i["label"] === "string" && CHECK_STATES.includes(i["state"] as CheckState)
    && (i["evidence"] === null || typeof i["evidence"] === "string") && typeof i["meaning"] === "string")) return false;
  if (!isObj(s) || s["score"] !== null || typeof s["complete"] !== "boolean") return false;
  const unknown = list.filter((i) => i["state"] === "unknown").length;
  if (s["unknown"] !== unknown || s["complete"] !== (unknown === 0)) return false; // an incomplete source can never read as complete
  return c === null || (isObj(c) && pct(c["largestAccountPct"]) && pct(c["top10AccountsPct"]));
}
