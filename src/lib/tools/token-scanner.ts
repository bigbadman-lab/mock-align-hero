// Browser- and server-safe contract for Token Scanner v1. No secrets here.
export const TS_SCHEMA = "mcpx.tool-execution.token-scanner.v1";
export const TS_TOOL_ID = "token_scanner";
export const TS_ENDPOINT = "/api/tools/token-scanner";
export const TS_CLIENT_TIMEOUT_MS = 30_000;

export type TokenScanStatus = "mint" | "not_found" | "not_token_program" | "not_a_mint" | "unparsed";
export interface TokenExtension { name: string; decoded: boolean; state: string | null }
export interface TokenScannerResult {
  schema: typeof TS_SCHEMA;
  executionId: string;
  toolId: typeof TS_TOOL_ID;
  network: "solana-mainnet";
  source: string;
  commitment: string;
  mint: string;
  fetchedAt: string;
  accountSlot: number;
  status: TokenScanStatus;
  program: "spl-token" | "token-2022" | null;
  owner: string | null;
  accountType: string | null;
  isInitialized: boolean | null;
  decimals: number | null;
  supplyRaw: string | null;
  supplyUi: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: TokenExtension[] | null;
  extensionsComplete: boolean | null;
  supplyCheck: { status: "ok" | "unavailable" | "not_applicable"; slot: number | null; supplyRaw: string | null; matches: boolean | null };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === null || isStr(v);
const nInt = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const digits = (v: unknown) => v === null || (isStr(v) && /^\d{1,20}$/.test(v));

/** Strict shape check of the worker response before it reaches the browser. */
export function isTokenScannerResult(v: unknown, mint: string): v is TokenScannerResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const sc = r["supplyCheck"] as Record<string, unknown> | undefined;
  const ex = r["extensions"];
  const ok = r["schema"] === TS_SCHEMA && r["toolId"] === TS_TOOL_ID && r["network"] === "solana-mainnet" && r["mint"] === mint
    && isStr(r["executionId"]) && isStr(r["fetchedAt"]) && !Number.isNaN(Date.parse(r["fetchedAt"] as string)) && nInt(r["accountSlot"]) && r["accountSlot"] !== null
    && ["mint", "not_found", "not_token_program", "not_a_mint", "unparsed"].includes(r["status"] as string)
    && [null, "spl-token", "token-2022"].includes(r["program"] as string)
    && optStr(r["owner"]) && optStr(r["accountType"]) && (r["isInitialized"] === null || typeof r["isInitialized"] === "boolean")
    && (r["decimals"] === null || (Number.isInteger(r["decimals"]) && (r["decimals"] as number) <= 255))
    && digits(r["supplyRaw"]) && optStr(r["supplyUi"]) && optStr(r["mintAuthority"]) && optStr(r["freezeAuthority"])
    && (r["extensionsComplete"] === null || typeof r["extensionsComplete"] === "boolean")
    && (ex === null || (Array.isArray(ex) && ex.length <= 32 && ex.every((e: Record<string, unknown>) => isStr(e["name"]) && typeof e["decoded"] === "boolean" && optStr(e["state"]) && (e["state"] === null || (e["state"] as string).length <= 601))))
    && !!sc && ["ok", "unavailable", "not_applicable"].includes(sc["status"] as string) && nInt(sc["slot"]) && digits(sc["supplyRaw"]) && (sc["matches"] === null || typeof sc["matches"] === "boolean");
  if (!ok) return false;
  // A "mint" result must carry its core facts; anything else must not.
  return r["status"] === "mint" ? r["program"] !== null && r["decimals"] !== null && r["supplyRaw"] !== null : r["supplyRaw"] === null && r["decimals"] === null;
}
