// Browser- and server-safe contract for Account Checker v1. No secrets here.
export const AC_SCHEMA = "mcpx.tool-execution.account-checker.v1";
export const AC_TOOL_ID = "account_checker";
export const AC_ENDPOINT = "/api/tools/account-checker";
export const AC_CLIENT_TIMEOUT_MS = 30_000;

export type AccountClass = "executable_program" | "system_owned" | "spl_token_owned" | "token_2022_owned" | "loader_owned" | "other_program_owned";
export interface AccountCheckerResult {
  schema: typeof AC_SCHEMA; executionId: string; toolId: typeof AC_TOOL_ID; network: "solana-mainnet"; commitment: string;
  address: string; fetchedAt: string; slot: number; exists: boolean;
  owner: string | null; executable: boolean | null; lamports: string | null; sol: string | null; space: number | null; classification: AccountClass | null;
}
const CLASSES = ["executable_program", "system_owned", "spl_token_owned", "token_2022_owned", "loader_owned", "other_program_owned"];
const isStr = (v: unknown): v is string => typeof v === "string";

/** Strict shape check of the worker response before it reaches the browser. */
export function isAccountCheckerResult(v: unknown, address: string): v is AccountCheckerResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (!(r["schema"] === AC_SCHEMA && r["toolId"] === AC_TOOL_ID && r["network"] === "solana-mainnet" && r["address"] === address
    && isStr(r["executionId"]) && isStr(r["fetchedAt"]) && !Number.isNaN(Date.parse(r["fetchedAt"] as string))
    && typeof r["slot"] === "number" && Number.isSafeInteger(r["slot"]) && typeof r["exists"] === "boolean")) return false;
  if (!r["exists"]) return ["owner", "executable", "lamports", "sol", "space", "classification"].every((k) => r[k] === null);
  return isStr(r["owner"]) && typeof r["executable"] === "boolean" && isStr(r["lamports"]) && /^\d{1,20}$/.test(r["lamports"] as string) && isStr(r["sol"])
    && (r["space"] === null || (typeof r["space"] === "number" && Number.isSafeInteger(r["space"]) && (r["space"] as number) >= 0))
    && CLASSES.includes(r["classification"] as string);
}
