// Fixed worker contracts for each Canvas capability. Adding a capability = catalog entry + one adapter here
// (test-checked to match 1:1). No adapter accepts URLs, headers, code or free-form parameters.
import { WI_SCHEMA, isValidSolanaAddress, isWalletInspectorResult } from "@/lib/tools/wallet-inspector";
import { WW_SCHEMA, WW_DEFAULT_THRESHOLD, isWhaleWatchResult } from "@/lib/tools/whale-watch";
import { TS_SCHEMA, isTokenScannerResult } from "@/lib/tools/token-scanner";
import { SM_SCHEMA, isSupplyMonitorResult } from "@/lib/tools/supply-monitor";
import { TV_SCHEMA, isTransactionVerifierResult, isValidSignature } from "@/lib/tools/transaction-verifier";
import { AC_SCHEMA, isAccountCheckerResult } from "@/lib/tools/account-checker";
import { HI_SCHEMA, isHolderIntelligenceResult } from "@/lib/tools/holder-intelligence";
import { TRA_SCHEMA, isTokenRiskResult } from "@/lib/tools/token-risk-analyst";
import type { ValueKind } from "./catalog";

export interface CapabilityAdapter {
  schema: string;
  input: (v: string) => Record<string, string>;
  check: (out: unknown, v: string) => boolean;
}

export const validValue = (kind: ValueKind, v: string) => (kind === "signature" ? isValidSignature(v) : isValidSolanaAddress(v));

export const CANVAS_ADAPTERS: Readonly<Record<string, CapabilityAdapter>> = Object.freeze({
  "wallet.inspect": { schema: WI_SCHEMA, input: (address) => ({ address }), check: (o, v) => isWalletInspectorResult(o, v) },
  "wallet.whale": { schema: WW_SCHEMA, input: (address) => ({ address, minLamports: WW_DEFAULT_THRESHOLD }), check: (o, v) => isWhaleWatchResult(o, v, WW_DEFAULT_THRESHOLD) },
  "token.scan": { schema: TS_SCHEMA, input: (mint) => ({ mint }), check: (o, v) => isTokenScannerResult(o, v) },
  "token.supply": { schema: SM_SCHEMA, input: (mint) => ({ mint }), check: (o, v) => isSupplyMonitorResult(o, v) },
  "verify.tx": { schema: TV_SCHEMA, input: (signature) => ({ signature }), check: (o, v) => isTransactionVerifierResult(o, v) },
  "verify.account": { schema: AC_SCHEMA, input: (address) => ({ address }), check: (o, v) => isAccountCheckerResult(o, v) },
  "intel.holders": { schema: HI_SCHEMA, input: (mint) => ({ mint }), check: (o, v) => isHolderIntelligenceResult(o, v) },
  "intel.risk": { schema: TRA_SCHEMA, input: (mint) => ({ mint }), check: (o, v) => isTokenRiskResult(o, v) },
});
