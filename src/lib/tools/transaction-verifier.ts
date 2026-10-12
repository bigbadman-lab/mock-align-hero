// Browser- and server-safe contract for Transaction Verifier v1. No secrets here.
export const TV_SCHEMA = "mcpx.tool-execution.transaction-verifier.v1";
export const TV_TOOL_ID = "transaction_verifier";
export const TV_ENDPOINT = "/api/tools/transaction-verifier";
export const TV_CLIENT_TIMEOUT_MS = 30_000;

export interface TransactionVerifierResult {
  schema: typeof TV_SCHEMA;
  executionId: string;
  toolId: typeof TV_TOOL_ID;
  network: "solana-mainnet";
  source: string;
  commitmentsChecked: string[];
  maxSupportedTransactionVersion: number;
  signature: string;
  fetchedAt: string;
  found: boolean;
  confirmation: "finalized" | "confirmed" | null;
  execution: "succeeded" | "failed" | "unknown" | null;
  slot: number | null;
  blockTime: number | null;
  version: "legacy" | 0 | null;
  feeLamports: string | null;
  feeSol: string | null;
  feePayer: string | null;
  signers: string[] | null;
  accountCount: number | null;
  loadedAddressCount: number | null;
  programIds: string[] | null;
  topLevelInstructionCount: number | null;
  computeUnitsConsumed: number | null;
  logMessageCount: number | null;
  error: { summary: string; detail: string } | null;
  metaAvailable: boolean;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Decoded byte length of a base58 string, or -1 if not base58. */
export function base58Length(s: string): number {
  let n = 0n;
  for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) return -1; n = n * 58n + BigInt(i); }
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  for (const c of s) { if (c === "1") bytes++; else break; }
  return bytes;
}
/** Exact 64-byte base58 signature; caller trims outer whitespace, inner whitespace is rejected. */
export function isValidSignature(s: string): boolean {
  return s.length >= 64 && s.length <= 88 && base58Length(s) === 64;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const nInt = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const strArr = (v: unknown, max: number) => v === null || (Array.isArray(v) && v.length <= max && v.every(isStr));

/** Strict shape check of the worker response before it reaches the browser. */
export function isTransactionVerifierResult(v: unknown, signature: string): v is TransactionVerifierResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const err = r["error"] as Record<string, unknown> | null | undefined;
  const base = r["schema"] === TV_SCHEMA && r["toolId"] === TV_TOOL_ID && r["network"] === "solana-mainnet"
    && r["signature"] === signature && isStr(r["executionId"]) && isStr(r["fetchedAt"]) && !Number.isNaN(Date.parse(r["fetchedAt"] as string))
    && typeof r["found"] === "boolean" && typeof r["metaAvailable"] === "boolean" && strArr(r["commitmentsChecked"], 2)
    && [null, "finalized", "confirmed"].includes(r["confirmation"] as string) && [null, "succeeded", "failed", "unknown"].includes(r["execution"] as string)
    && nInt(r["slot"]) && nInt(r["blockTime"]) && (r["version"] === null || r["version"] === "legacy" || r["version"] === 0)
    && (r["feeLamports"] === null || (isStr(r["feeLamports"]) && /^\d+$/.test(r["feeLamports"] as string))) && (r["feeSol"] === null || isStr(r["feeSol"]))
    && (r["feePayer"] === null || isStr(r["feePayer"])) && strArr(r["signers"], 32) && strArr(r["programIds"], 64)
    && nInt(r["accountCount"]) && nInt(r["loadedAddressCount"]) && nInt(r["topLevelInstructionCount"]) && nInt(r["computeUnitsConsumed"]) && nInt(r["logMessageCount"])
    && (err === null || (!!err && isStr(err["summary"]) && err["summary"].length <= 200 && isStr(err["detail"]) && err["detail"].length <= 501));
  if (!base) return false;
  // Consistency: found ⇔ confirmation+slot present; not-found carries no facts.
  return r["found"] ? r["confirmation"] !== null && r["slot"] !== null : r["confirmation"] === null && r["slot"] === null && r["execution"] === null;
}
