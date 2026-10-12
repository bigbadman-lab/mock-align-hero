// LaunchPrepareContractV1 — typed mirror of services/transaction-builder/src/contract.mjs.
// Server-only use; no route or UI calls the builder in Phase 04-A.

export const LAUNCH_PREPARE_SCHEMA = "mcpx.launch.prepare.v1" as const;
export type BuyMode = "buy_v2" | "buy_v3" | "buy_exact_quote_in_v3";
export type TxFormat = "legacy" | "v0" | "v0_alt";

export interface LaunchPrepareContractV1 {
  schema: typeof LAUNCH_PREPARE_SCHEMA;
  idempotencyKey: string;
  creator: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  initialBuy: null | { mode: BuyMode; quoteAmount: string; slippageBps: number };
  format: TxFormat;
}

export type BuilderStatus =
  | { state: "BUILDER_NOT_DEPLOYED" }
  | { state: "BUILDER_UNREACHABLE" }
  | { state: "BUILDER_TIMEOUT" }
  | { state: "BUILDER_UNHEALTHY" }
  | { state: "BUILDER_MALFORMED" }
  | { state: "BUILDER_NOT_CONFIGURED"; quoteMint: string }
  | { state: "BUILDER_READY_FOR_PREPARE"; quoteMint: string; launchEnabled: false };

/** Interprets the builder's public /ready report; never claims launch capability. */
export function interpretReady(body: unknown): BuilderStatus {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { state: "BUILDER_MALFORMED" };
  if (typeof (body as Record<string, unknown>)["ready"] !== "boolean") return { state: "BUILDER_MALFORMED" };
  const b = body as Record<string, unknown>;
  const quoteMint = b["quoteMint"] === "CONFIGURED" ? "CONFIGURED" : "QUOTE_MINT_MISSING";
  if (b["ready"] !== true) return { state: "BUILDER_NOT_CONFIGURED", quoteMint };
  return { state: "BUILDER_READY_FOR_PREPARE", quoteMint, launchEnabled: false };
}
