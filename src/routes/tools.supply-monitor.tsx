import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { supplyMonitorStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { SM_CLIENT_TIMEOUT_MS, SM_ENDPOINT, type SupplyMonitorResult } from "@/lib/tools/supply-monitor";

export const Route = createFileRoute("/tools/supply-monitor")({
  head: () => ({
    meta: [
      { title: "Supply Monitor — MCPX" },
      { name: "description", content: "On-demand snapshot of a Solana token's total supply and its 20 largest token accounts. Read-only, no history or alerts." },
      { property: "og:title", content: "Supply Monitor — MCPX" },
      { property: "og:description", content: "Total onchain supply plus the largest token accounts for one Solana mint — token accounts, not holders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SupplyMonitorPage,
  errorComponent: RouteError,
});

type Kind = "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error" | "unavailable" | "too_large" | "bad_response" | "network" | "free_limit";
const ERROR_TEXT: Record<Kind, string> = {
  invalid_input: "That isn't a valid Solana public address.",
  rate_limited: "Too many requests right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error, so no supply is shown.",
  unavailable: "Supply Monitor is unavailable right now.",
  too_large: "The provider's answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  free_limit: "You've used today's 3 free tests of this tool.",
};
const DIST_REASON: Record<string, string> = {
  rate_limited: "the data provider rate-limited the request",
  timeout: "the data provider didn't answer in time",
  provider_error: "the data provider refused or errored on this request",
  bad_response: "the data provider's answer couldn't be verified",
  too_large: "the answer was too large",
};
class ToolError extends Error { constructor(public kind: Kind) { super(kind); } }

async function runCheck(mint: string, signal: AbortSignal): Promise<SupplyMonitorResult> {
  let r: Response;
  try {
    r = await fetch(SM_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint }), signal: AbortSignal.any([signal, AbortSignal.timeout(SM_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !body || !("schema" in body)) {
    const k = body?.["error"] as Kind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return body as unknown as SupplyMonitorResult;
}

function SupplyMonitorPage() {
  const status = useQuery(supplyMonitorStatusQuery);
  const [mint, setMint] = useState("");
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (m: string) => { abort.current?.abort(); abort.current = new AbortController(); return runCheck(m, abort.current.signal); },
    retry: false,
  });
  const trimmed = mint.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (valid && available && !run.isPending) run.mutate(trimmed);
  };

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · TOKEN engine" title="Supply Monitor" intro="A one-time snapshot of a Solana token's total onchain supply and its largest token accounts, when you press the button. No history, no alerts, nothing runs in the background." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Token accounts are not people: one wallet can own several, and exchanges, pools or treasuries can hold many. Total supply is not circulating supply. No prices, holder counts or risk scores.
        </p>

        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title="Supply Monitor is not available yet">
            <p>{status.data.reason === "tool_not_deployed" ? "The execution service is running, but its Supply Monitor update hasn't been deployed yet." : "The execution service isn't connected, so checks can't run."} Nothing is simulated.</p>
          </StatusMessage>
        )}

        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-3" noValidate>
            <label htmlFor="sm-mint" className="label-mono block text-xs text-subtle">Token mint address</label>
            <input
              id="sm-mint" value={mint} onChange={(e) => setMint(e.target.value)} onBlur={() => setTouched(true)}
              maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby="sm-help"
              className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="Base58 mint address"
            />
            <p id="sm-help" className="text-xs text-muted-foreground">
              {touched && trimmed && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : "Mainnet only. Shared limits across all MCPX tools: 6 per minute, 40 per hour."}
            </p>
            <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>
              {run.isPending ? "Checking…" : "Check Supply"}
            </button>
          </form>
        )}

        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isPending && run.variables && <p className="break-all font-mono text-xs text-muted-foreground">Checking {run.variables}…</p>}
          {run.isError && (
            <StatusMessage tone="warning" title={(run.error as ToolError).kind === "free_limit" ? "Free tests used" : (run.error as ToolError).kind === "rate_limited" ? "Rate limited" : "Check failed"}>
              <p>{ERROR_TEXT[(run.error as ToolError).kind ?? "provider_error"]}</p>
              {(run.error as ToolError).kind === "free_limit" && <FreeLimitNotice />}
              {run.variables && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && !run.isPending && <ResultView r={run.data} />}
        </div>

        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

const PROGRAM_NAME = { "spl-token": "SPL Token (original)", "token-2022": "Token-2022" } as const;
const NOT_MINT: Record<string, string> = {
  not_found: "No account exists at this address (at confirmed).",
  not_token_program: "This account isn't owned by SPL Token or Token-2022, so it isn't a token mint.",
  not_a_mint: "This is a token-program account, but not a mint (it may be a token holding account).",
  unparsed: "The provider couldn't decode this token-program account, so nothing is shown.",
};

function ResultView({ r }: { r: SupplyMonitorResult }) {
  const url = explorerAccountUrl(r.mint);
  return (
    <section aria-labelledby="sm-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sm-result" className="text-lg font-semibold text-foreground">Snapshot</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.mint}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</p>

      {r.status !== "mint" || !r.supply || !r.distribution ? (
        <StatusMessage tone="warning" title="Not a token mint"><p>{NOT_MINT[r.status] ?? "Not a token mint."}</p></StatusMessage>
      ) : (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div><dt className="text-subtle">Token program</dt><dd className="text-foreground">{r.program ? PROGRAM_NAME[r.program] : "Unavailable"}</dd></div>
            <div><dt className="text-subtle">Decimals</dt><dd className="font-mono text-foreground">{r.decimals}</dd></div>
            <div><dt className="text-subtle">Total supply (slot {r.supply.slot})</dt><dd className="break-all font-mono text-foreground">{r.supply.ui}<span className="block text-xs text-muted-foreground">{r.supply.raw} base units</span></dd></div>
          </dl>

          {r.distribution.status !== "ok" ? (
            <StatusMessage tone="warning" title="Largest accounts unavailable — partial result">
              <p>The total supply above is verified, but the largest-accounts list couldn't be read because {DIST_REASON[r.distribution.reason ?? ""] ?? "of a provider problem"}. This is not a full snapshot.</p>
            </StatusMessage>
          ) : (
            <div className="space-y-3 text-sm">
              <h3 className="font-medium text-foreground">Top {r.distribution.accounts.length} returned token accounts (slot {r.distribution.slot})</h3>
              <p className="text-muted-foreground">
                Together: <span className="font-mono text-foreground">{r.distribution.returnedTotalUi}</span>
                {r.distribution.returnedSharePct !== null ? <> — <span className="font-mono text-foreground">{r.distribution.returnedSharePct}%</span> of total supply</> : " — share N/A (total supply is 0)"}.
              </p>
              {r.distribution.accounts.length === 0 ? <p className="text-muted-foreground">The provider returned no token accounts for this mint.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-subtle"><tr><th className="py-2 pr-4 font-normal">#</th><th className="py-2 pr-4 font-normal">Token account</th><th className="py-2 pr-4 font-normal">Balance</th><th className="py-2 font-normal">Share</th></tr></thead>
                    <tbody>
                      {r.distribution.accounts.map((a, i) => (
                        <tr key={a.address} className="border-t border-border font-mono">
                          <td className="py-2 pr-4 text-muted-foreground">{i + 1}</td>
                          <td className="py-2 pr-4"><a className="underline" href={`https://solscan.io/account/${encodeURIComponent(a.address)}`} target="_blank" rel="noreferrer" title={a.address}>{shortAddress(a.address)}</a></td>
                          <td className="break-all py-2 pr-4 text-foreground">{a.ui}<span className="block text-xs text-muted-foreground">{a.raw}</span></td>
                          <td className="py-2 text-muted-foreground">{a.sharePct !== null ? `${a.sharePct}%` : "N/A"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Order and list as returned by the data provider (up to 20). These are token accounts, not holders; this is not the full distribution. Percentages are rounded down to 4 decimal places.</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {r.sameSlot ? "All reads observed the same slot." : "Reads observed different slots, so this is a near-time snapshot, not one atomic moment."}
          </p>
        </>
      )}
      <p className="text-xs text-muted-foreground">Observed (UTC) {r.observedAt} — when MCPX asked, not a block time. Mint read at slot {r.accountSlot} ({r.commitment}). Source: Solana mainnet via Helius.</p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
