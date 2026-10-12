// Launch readiness model (Phase 04-C). Each prerequisite is reported individually; nothing aggregates
// partial data into "ready". Items stay BLOCKED until real on-chain proof exists in a later phase.
import type { BuilderStatus } from "@/lib/tx-builder/contract";

export type ReadyState = "READY" | "NOT_CONFIGURED" | "BLOCKED" | "UNKNOWN";
export interface ReadinessItem { id: string; label: string; state: ReadyState; detail: string }

export function builderItem(s: BuilderStatus): ReadinessItem {
  const base = { id: "builder", label: "Dedicated transaction builder" };
  switch (s.state) {
    case "BUILDER_NOT_DEPLOYED": return { ...base, state: "NOT_CONFIGURED", detail: "Not deployed yet." };
    case "BUILDER_TIMEOUT": return { ...base, state: "UNKNOWN", detail: "Did not answer in time." };
    case "BUILDER_MALFORMED": return { ...base, state: "UNKNOWN", detail: "Answered with an unreadable report." };
    case "BUILDER_UNREACHABLE": return { ...base, state: "UNKNOWN", detail: "Could not be reached." };
    case "BUILDER_NOT_CONFIGURED": return { ...base, state: "NOT_CONFIGURED", detail: "Running but missing required settings." };
    case "BUILDER_READY_FOR_PREPARE": return { ...base, state: "READY", detail: "Running and able to prepare drafts. It cannot sign or send." };
  }
}

/** Server-side prerequisites. Only the builder item is read live; the rest have no proof yet. */
export function serverReadiness(s: BuilderStatus): ReadinessItem[] {
  const quoteConfigured = (s.state === "BUILDER_READY_FOR_PREPARE" || s.state === "BUILDER_NOT_CONFIGURED") && s.quoteMint === "CONFIGURED";
  return [
    {
      id: "parent", label: "Canonical $MCP parent token",
      state: "BLOCKED",
      detail: quoteConfigured
        ? "A parent address is set on the builder, but $MCP has not been verified as minted and eligible."
        : "$MCP has not been minted, so no child token can be paired with it.",
    },
    { id: "alt", label: "Production lookup table", state: "BLOCKED", detail: "Not created on chain. Needed to fit the fee-first creation in one transaction." },
    builderItem(s),
    { id: "simulation", label: "Full fee-first simulation (create → fee sharing → 60/25/15)", state: "BLOCKED", detail: "Needs the real parent token and lookup table first." },
    { id: "storage", label: "Verified token metadata storage", state: "NOT_CONFIGURED", detail: "No approved public storage for artwork and metadata yet." },
    { id: "signing", label: "Approved signing flow", state: "BLOCKED", detail: "Transaction signing has not been approved. This site only signs sign-in messages." },
  ];
}
