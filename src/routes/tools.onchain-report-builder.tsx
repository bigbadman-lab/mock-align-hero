import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { QUOTA_HELP, ToolErrorBox, ToolStatusBanner, postTool } from "@/components/mcpx/MintToolShell";
import { onchainReportStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { ORB_CLIENT_TIMEOUT_MS, ORB_ENDPOINT, type OnchainReport, type TargetType } from "@/lib/tools/onchain-report";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tools/onchain-report-builder")({
  head: () => ({
    meta: [
      { title: "Onchain Report Builder — MCPX" },
      { name: "description", content: "A sourced, point-in-time report for one Solana wallet or token, built from existing MCPX tools. Partial parts are marked, never filled in." },
      { property: "og:title", content: "Onchain Report Builder — MCPX" },
      { property: "og:description", content: "One deterministic report for a wallet or token — evidence for every line, no AI, no verdicts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  errorComponent: RouteError,
});

const TOOL_NAME: Record<string, string> = { wallet_inspector: "Wallet Inspector", account_checker: "Account Checker", token_scanner: "Token Scanner", supply_monitor: "Supply Monitor" };

function Page() {
  const status = useQuery(onchainReportStatusQuery);
  const [type, setType] = useState<TargetType>("wallet");
  const [target, setTarget] = useState("");
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (b: { targetType: TargetType; target: string }) => { abort.current?.abort(); abort.current = new AbortController(); return postTool<OnchainReport>(ORB_ENDPOINT, b, abort.current.signal, ORB_CLIENT_TIMEOUT_MS); },
    retry: false,
  });
  const t = target.trim();
  const valid = isValidSolanaAddress(t);
  const available = status.data?.available === true;

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · Intelligence" title="Onchain Report Builder" intro="One report for a wallet or a token, put together from existing MCPX tools, with the source of every line." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">Wallet reports combine Wallet Inspector and Account Checker; token reports combine Token Scanner and Supply Monitor. Written by fixed rules — no AI, no scores and no safety verdicts. One report = one free test.</p>
        <ToolStatusBanner name="Onchain Report Builder" status={status} />
        {available && (
          <form onSubmit={(e) => { e.preventDefault(); if (valid && !run.isPending) run.mutate({ targetType: type, target: t }); }} className="max-w-2xl space-y-3" noValidate>
            <fieldset className="flex gap-2"><legend className="label-mono mb-2 block text-xs text-subtle">Report on</legend>
              {(["wallet", "token"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={type === k} onClick={() => setType(k)} className={cn("rounded-md border px-4 py-2 text-sm", type === k ? "border-primary text-primary" : "border-border text-muted-foreground")}>{k === "wallet" ? "A wallet" : "A token"}</button>
              ))}
            </fieldset>
            <label htmlFor="orb-target" className="label-mono block text-xs text-subtle">{type === "wallet" ? "Wallet address" : "Token mint address"}</label>
            <input id="orb-target" value={target} onChange={(e) => setTarget(e.target.value)} maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={!!t && !valid}
              className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary" placeholder="Base58 address" />
            <p className="text-xs text-muted-foreground">{t && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : QUOTA_HELP}</p>
            <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending}>{run.isPending ? "Building…" : "Build Report"}</button>
          </form>
        )}
        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isError && <ToolErrorBox error={run.error} onRetry={() => run.variables && run.mutate(run.variables)} />}
          {run.data && !run.isPending && <Report r={run.data} />}
        </div>
        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

function Report({ r }: { r: OnchainReport }) {
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
