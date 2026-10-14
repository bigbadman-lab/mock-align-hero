// Result renderer shared by the Tool Library page and launched-product pages.
import { RouteError, StatusMessage } from "@/components/mcpx/primitives";
import { MintToolShell, NOT_MINT, PROGRAM_NAME } from "@/components/mcpx/MintToolShell";
import { explorerAccountUrl } from "@/lib/wallet/state";
import { tokenRiskAnalystStatusQuery } from "@/lib/tools/status";
import { STATE_MEANING, TRA_CLIENT_TIMEOUT_MS, TRA_ENDPOINT, type CheckState, type TokenRiskResult } from "@/lib/tools/token-risk-analyst";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<CheckState, string> = { observed: "Observed", not_observed: "Not observed", unknown: "Unknown", not_applicable: "Not applicable" };
const STATE_TONE: Record<CheckState, string> = { observed: "border-primary/50 text-primary", not_observed: "border-border text-foreground", unknown: "border-warning/60 text-warning", not_applicable: "border-border text-subtle" };

export function TokenRiskResultView({ r }: { r: TokenRiskResult }) {
  const url = explorerAccountUrl(r.mint);
  return (
    <section aria-labelledby="tra-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tra-result" className="text-lg font-semibold text-foreground">Evidence checklist</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.mint}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</p>
      {r.status !== "mint" || !r.summary ? (
        <StatusMessage tone="warning" title="Not a token mint"><p>{NOT_MINT[r.status] ?? "Not a token mint."}</p></StatusMessage>
      ) : (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div><dt className="text-subtle">Token</dt><dd className="text-foreground">{r.metadata?.status === "ok" ? `${r.metadata.name ?? "?"} (${r.metadata.symbol ?? "?"})` : "Name not read"}</dd></div>
            <div><dt className="text-subtle">Token program</dt><dd className="text-foreground">{r.program ? PROGRAM_NAME[r.program] : "Unavailable"}</dd></div>
            <div><dt className="text-subtle">Total supply</dt><dd className="break-all font-mono text-foreground">{r.supply?.ui}</dd></div>
          </dl>
          {r.summary.complete ? (
            <p className="text-sm text-muted-foreground">Every check below could be determined: {r.summary.observed} observed, {r.summary.notObserved} not observed, {r.summary.notApplicable} not applicable. This describes onchain settings only, not whether the token is a good or safe investment.</p>
          ) : (
            <StatusMessage tone="warning" title="Incomplete — some checks could not be determined">
              <p>{r.summary.unknown} check{r.summary.unknown === 1 ? "" : "s"} returned Unknown. Don't read the rest as reassurance.</p>
            </StatusMessage>
          )}
          <ul className="space-y-3">
            {r.checklist.map((i) => (
              <li key={i.id} className="rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{i.label}</span>
                  <span className={cn("rounded border px-2 py-0.5 font-mono text-[11px]", STATE_TONE[i.state])}>{STATE_LABEL[i.state]}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{i.meaning}</p>
                {i.evidence && <p className="mt-1 break-all font-mono text-xs text-subtle">Evidence: {i.evidence}</p>}
              </li>
            ))}
          </ul>
          <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            {(Object.keys(STATE_MEANING) as CheckState[]).map((s) => <div key={s}><dt className="inline font-medium text-foreground">{STATE_LABEL[s]}: </dt><dd className="inline">{STATE_MEANING[s]}</dd></div>)}
          </dl>
          <p className="text-xs text-muted-foreground">Concentration uses the largest token accounts only{r.concentration ? ` (${r.concentration.observedAccounts} observed)` : ""}; a token account can be a pool, exchange or program, not one person.</p>
        </>
      )}
      <p className="text-xs text-muted-foreground">Observed (UTC) {r.observedAt} ({r.commitment}). Source: Solana mainnet via Helius — {r.methods.join(", ")} ({r.rpcCalls} calls).</p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
