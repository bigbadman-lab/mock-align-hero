// Browser- and server-safe contract for Wallet Inspector v1. No secrets here.
import { isAddress } from "@solana/addresses";

export const WI_SCHEMA = "mcpx.tool-execution.wallet-inspector.v1";
export const WI_TOOL_ID = "wallet_inspector";
export const WI_ENDPOINT = "/api/tools/wallet-inspector";
export const WI_CLIENT_TIMEOUT_MS = 30_000;

export interface TokenHolding {
  mint: string;
  program: string;
  amountRaw: string;
  decimals: number;
  amountUi: string;
  tokenAccounts: number;
}
export interface WalletInspectorResult {
  schema: typeof WI_SCHEMA;
  executionId: string;
  toolId: typeof WI_TOOL_ID;
  network: "solana-mainnet";
  commitment: string;
  source: string;
  address: string;
  fetchedAt: string;
  solBalance: { lamports: string; solUi: string } | null;
  tokenHoldings: TokenHolding[];
  sourceSlots: { balance: number | null; splToken: number | null; token2022: number | null };
  coverage: { balance: boolean; splToken: boolean; token2022: boolean };
  partial: boolean;
  warnings: { part: string; kind: string; message: string }[];
}
export type ToolErrorKind =
  | "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error"
  | "unavailable" | "too_large" | "bad_response" | "network";

/** Real 32-byte Solana public key check (not a regex). */
export function isValidSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return isAddress(s); // decodes base58 and requires exactly 32 bytes
}

const isStr = (v: unknown): v is string => typeof v === "string";
const slot = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

/** Strict shape check of the worker response before it reaches the browser. */
export function isWalletInspectorResult(v: unknown, address: string): v is WalletInspectorResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const s = r["sourceSlots"] as Record<string, unknown> | undefined;
  const sol = r["solBalance"] as Record<string, unknown> | null | undefined;
  const h = r["tokenHoldings"];
  return r["schema"] === WI_SCHEMA && r["toolId"] === WI_TOOL_ID && r["network"] === "solana-mainnet"
    && r["address"] === address && isStr(r["executionId"]) && isStr(r["fetchedAt"]) && !Number.isNaN(Date.parse(r["fetchedAt"] as string))
    && typeof r["partial"] === "boolean" && Array.isArray(r["warnings"])
    && (sol === null || (!!sol && isStr(sol["lamports"]) && /^\d+$/.test(sol["lamports"] as string) && isStr(sol["solUi"])))
    && !!s && slot(s["balance"]) && slot(s["splToken"]) && slot(s["token2022"])
    && Array.isArray(h) && h.length <= 1000
    && h.every((x: Record<string, unknown>) => isStr(x["mint"]) && isStr(x["program"]) && isStr(x["amountRaw"]) && /^\d+$/.test(x["amountRaw"] as string) && Number.isInteger(x["decimals"]) && isStr(x["amountUi"]) && Number.isInteger(x["tokenAccounts"]));
}
