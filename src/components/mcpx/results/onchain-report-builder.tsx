// Result renderer shared by the Tool Library page and launched-product pages.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { QUOTA_HELP, ToolErrorBox, ToolStatusBanner, postTool } from "@/components/mcpx/MintToolShell";
import { onchainReportStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { ORB_CLIENT_TIMEOUT_MS, ORB_ENDPOINT, type OnchainReport, type TargetType } from "@/lib/tools/onchain-report";
import { cn } from "@/lib/utils";

const TOOL_NAME: Record<string, string> = { wallet_inspector: "Wallet Inspector", account_checker: "Account Checker", token_scanner: "Token Scanner", supply_monitor: "Supply Monitor" };
export function OnchainReportView({ r }: { r: OnchainReport }) {
  return (
    <section aria-labelledby="orb-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="orb-result" className="text-lg font-semibold text-foreground">{r.targetType === "wallet" ? "Wallet" : "Token"} report</h2>
        <span className={cn("label-mono text-xs", r.status === "complete" ? "text-primary" : "text-warning")}>{r.status === "complete" ? "Complete" : "PARTIAL"}</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.target}</p>
      {r.status === "partial" && <StatusMessage tone="warning" title="Partial report"><p>At least one part failed or was incomplete. Missing parts are unknown, not zero — don't draw conclusions from what's absent.</p></StatusMessage>}
      <ul className="space-y-3">
        {r.findings.map((f) => (
          <li key={f.id} className="rounded-md border border-border p-4 text-sm">
            <p className="break-words text-foreground">{f.text}</p>
            <p className="mt-1 font-mono text-xs text-subtle">{f.evidence ? `Source: ${f.evidence}` : "Source: unavailable"}</p>
          </li>
        ))}
      </ul>
      {r.holdings && r.holdings.length > 0 && (
        <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Largest holdings by raw amount (up to 10)</summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">{r.holdings.map((h) => <li key={h.mint} className="break-all text-muted-foreground">{h.mint} — {h.amountUi}</li>)}</ul>
        </details>
      )}
      <div className="text-xs text-muted-foreground">
        <p>Built from: {r.components.map((c) => `${TOOL_NAME[c.tool] ?? c.tool} (${c.status}${c.error ? `: ${c.error}` : ""})`).join(", ")}.</p>
        <ul className="mt-2 list-disc pl-5">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="mt-2">Generated {r.generatedAt}. {r.usage.rpcCalls} of {r.usage.callBudget} provider calls, {r.usage.ms} ms. Source: Solana mainnet via Helius.</p>
      </div>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
