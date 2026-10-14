// CANVAS-01 capability catalog (v1). Server-owned, browser-safe, static.
// Each capability maps 1:1 to an existing tool whose worker handler and result type exist in src/lib/tools.
// Output "pick" paths are taken from those result interfaces; the browser only ever references IDs.
// Onchain Report Builder is deliberately excluded: it already composes other tools (no recursion).
export const CANVAS_CATALOG_VERSION = 1;
export const CANVAS_MAX_STEPS = 4;
export const CANVAS_MIN_STEPS = 2;

/** Value kinds that may flow between steps. Nothing else is ever propagated. */
export type ValueKind = "wallet" | "mint" | "signature" | "account";

export interface CapabilityOutput {
  id: string;
  kind: ValueKind;
  label: string;
  /** Fixed extraction path on the tool's typed result (array → first item). Never user-supplied. */
  path: string;
}

export interface Capability {
  id: string;
  version: number;
  templateId: string;
  toolId: string;
  name: string;
  input: { kind: ValueKind; label: string };
  outputs: CapabilityOutput[];
  /** Shared relay bucket; Canvas never gets its own capacity. */
  rateBucket: "tools:*";
  timeoutMs: number;
}

const cap = (c: Omit<Capability, "version" | "rateBucket" | "timeoutMs">): Capability =>
  Object.freeze({ ...c, version: 1, rateBucket: "tools:*", timeoutMs: 30_000 });

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  cap({ id: "wallet.inspect", templateId: "wallet-inspector", toolId: "wallet_inspector", name: "Wallet Inspector", input: { kind: "wallet", label: "Wallet address" },
    outputs: [{ id: "largest_holding_mint", kind: "mint", label: "First token held", path: "tokenHoldings[0].mint" }] }),
  cap({ id: "wallet.whale", templateId: "whale-watch", toolId: "whale_watch", name: "Whale Watch", input: { kind: "wallet", label: "Wallet address" },
    outputs: [
      { id: "latest_transfer_signature", kind: "signature", label: "Latest large transfer", path: "transfers[0].signature" },
      { id: "latest_counterparty", kind: "wallet", label: "Latest counterparty", path: "transfers[0].to" },
    ] }),
  cap({ id: "token.scan", templateId: "token-scanner", toolId: "token_scanner", name: "Token Scanner", input: { kind: "mint", label: "Token mint" }, outputs: [] }),
  cap({ id: "token.supply", templateId: "supply-monitor", toolId: "supply_monitor", name: "Supply Monitor", input: { kind: "mint", label: "Token mint" },
    outputs: [{ id: "largest_token_account", kind: "account", label: "Largest token account", path: "distribution.accounts[0].address" }] }),
  cap({ id: "verify.tx", templateId: "tx-verifier", toolId: "transaction_verifier", name: "Transaction Verifier", input: { kind: "signature", label: "Transaction signature" }, outputs: [] }),
  cap({ id: "verify.account", templateId: "account-checker", toolId: "account_checker", name: "Account Checker", input: { kind: "account", label: "Account address" }, outputs: [] }),
  cap({ id: "intel.holders", templateId: "holder-intelligence", toolId: "holder_intelligence", name: "Holder Intelligence", input: { kind: "mint", label: "Token mint" },
    outputs: [{ id: "largest_owner", kind: "wallet", label: "Largest observed owner", path: "distribution.owners[0].owner" }] }),
  cap({ id: "intel.risk", templateId: "token-risk-analyst", toolId: "token_risk_analyst", name: "Token Risk Analyst", input: { kind: "mint", label: "Token mint" }, outputs: [] }),
]);

export const CAPABILITY_BY_ID: Readonly<Record<string, Capability>> = Object.freeze(Object.fromEntries(CAPABILITIES.map((c) => [c.id, c])));

/** A wallet or account address is also a valid account to check; nothing else crosses kinds. */
export function kindAccepts(input: ValueKind, output: ValueKind): boolean {
  return input === output || (input === "account" && output === "wallet");
}

/** Read a fixed catalog path from a typed tool result. Returns only base58-looking strings. */
export function pick(result: unknown, path: string): string | null {
  let cur: unknown = result;
  for (const part of path.split(".")) {
    const m = /^([A-Za-z]+)(?:\[(\d)\])?$/.exec(part);
    if (!m || !cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[m[1]!];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  return typeof cur === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(cur) ? cur : null;
}
