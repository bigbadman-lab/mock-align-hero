import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { whaleWatchStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { WW_CLIENT_TIMEOUT_MS, WW_DEFAULT_THRESHOLD, WW_ENDPOINT, WW_THRESHOLDS, type WhaleWatchResult } from "@/lib/tools/whale-watch";

export const Route = createFileRoute("/tools/whale-watch")({
  head: () => ({
    meta: [
      { title: "Whale Watch — MCPX" },
      { name: "description", content: "On-demand look at recent large native SOL transfers to or from one Solana address. Bounded sample, read-only, no alerts." },
      { property: "og:title", content: "Whale Watch — MCPX" },
      { property: "og:description", content: "Recent native SOL transfers above a threshold for one address, from its latest 10 transactions. Native SOL only." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WhaleWatchPage,
  errorComponent: RouteError,
});

type Kind = "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error" | "unavailable" | "too_large" | "bad_response" | "network" | "free_limit";
const ERROR_TEXT: Record<Kind, string> = {
  invalid_input: "That isn't a valid Solana public address.",
  rate_limited: "Too many requests right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The data provider couldn't list this address's recent transactions, so nothing is shown.",
  unavailable: "Whale Watch is unavailable right now.",
  too_large: "The provider's answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  free_limit: "You've used today's 3 free tests of this tool.",
};
class ToolError extends Error { constructor(public kind: Kind) { super(kind); } }

async function runWatch(input: { address: string; minLamports: string }, signal: AbortSignal): Promise<WhaleWatchResult> {
  let r: Response;
  try {
    r = await fetch(WW_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(WW_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !body || !("schema" in body)) {
    const k = body?.["error"] as Kind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return body as unknown as WhaleWatchResult;
}

function WhaleWatchPage() {
  const status = useQuery(whaleWatchStatusQuery);
  const wallet = useWallet();
  const [address, setAddress] = useState("");
  const [min, setMin] = useState<string>(WW_DEFAULT_THRESHOLD);
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (i: { address: string; minLamports: string }) => { abort.current?.abort(); abort.current = new AbortController(); return runWatch(i, abort.current.signal); },
    retry: false,
  });
  const trimmed = address.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;
  // Hide results that no longer match the current inputs (no stale attribution).
  const stale = !!run.variables && (run.variables.address !== trimmed || run.variables.minLamports !== min);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (valid && available && !run.isPending) run.mutate({ address: trimmed, minLamports: min });
  };

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · WALLET engine" title="Whale Watch" intro="See recent large native SOL transfers to or from one Solana address — checked from its latest transactions when you press the button. Native SOL transfers only." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          This is a small, dated sample — the address's 20 most recent transactions, of which the newest 10 are inspected. Older transfers may exist. No tokens, prices, labels, alerts or network-wide whale discovery. An address is not an identity.
        </p>

        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title="Whale Watch is not deployed yet">
            <p>{status.data.reason === "tool_not_deployed" ? "The execution service is running, but its Whale Watch update hasn't been deployed yet." : "The execution service isn't connected, so checks can't run."} Nothing is simulated.</p>
          </StatusMessage>
        )}

        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-4" noValidate>
            <div className="space-y-2">
              <label htmlFor="ww-address" className="label-mono block text-xs text-subtle">Solana address</label>
              <input
                id="ww-address" value={address} onChange={(e) => setAddress(e.target.value)} onBlur={() => setTouched(true)}
                maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby="ww-help"
                className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                placeholder="Base58 address"
              />
              <p id="ww-help" className="text-xs text-muted-foreground">
                {touched && trimmed && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : "Mainnet only. Shared limits across all MCPX tools: 6 per minute, 40 per hour."}
              </p>
            </div>
            <fieldset className="space-y-2">
              <legend className="label-mono text-xs text-subtle">Minimum transfer</legend>
              <div className="flex flex-wrap gap-2">
                {WW_THRESHOLDS.map((t) => (
                  <label key={t.lamports} className={`cursor-pointer rounded-md border px-3 py-2 font-mono text-sm ${min === t.lamports ? "border-primary text-primary" : "border-border-strong text-muted-foreground"}`}>
                    <input type="radio" name="ww-min" value={t.lamports} checked={min === t.lamports} onChange={() => setMin(t.lamports)} className="sr-only" />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>
                {run.isPending ? "Checking…" : "Watch Transfers"}
              </button>
              {wallet.status === "connected_mainnet" && wallet.address && (
                <button type="button" className={buttonOutline} onClick={() => { setAddress(wallet.address!); setTouched(true); }}>Use connected wallet</button>
              )}
            </div>
          </form>
        )}

        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isPending && run.variables && <p className="break-all font-mono text-xs text-muted-foreground">Checking {run.variables.address}…</p>}
          {run.isError && !stale && (
            <StatusMessage tone="warning" title={(run.error as ToolError).kind === "free_limit" ? "Free tests used" : (run.error as ToolError).kind === "rate_limited" ? "Rate limited" : "Check failed"}>
              <p>{ERROR_TEXT[(run.error as ToolError).kind ?? "provider_error"]}</p>
              {(run.error as ToolError).kind === "free_limit" && <FreeLimitNotice />}
              {run.variables && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && !run.isPending && !stale && <ResultView r={run.data} />}
        </div>

        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

const DIR_LABEL = { IN: "In", OUT: "Out", SELF: "Self" } as const;

function ResultView({ r }: { r: WhaleWatchResult }) {
  const c = r.coverage;
  const url = explorerAccountUrl(r.address);
  const issues = [
    c.unavailableTransactions && `${c.unavailableTransactions} transaction(s) couldn't be read or had no execution data`,
    c.unsupportedVersion && `${c.unsupportedVersion} transaction(s) use an unsupported version`,
    c.partiallyDecoded && `${c.partiallyDecoded} transaction(s) had instructions that couldn't be fully decoded`,
    c.truncatedByBudget && `${c.truncatedByBudget} transaction(s) weren't checked because the time budget ran out`,
  ].filter(Boolean) as string[];
  return (
    <section aria-labelledby="ww-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ww-result" className="text-lg font-semibold text-foreground">Sample result</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.address}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</p>
      <p className="text-sm text-muted-foreground">
        Native SOL transfers of at least <span className="font-mono text-foreground">{r.minSol} SOL</span>. Inspected {c.transactionsAttempted} of the {c.signaturesSeen} most recent transactions
        {c.notInspected > 0 && ` (the ${c.notInspected} older ones were not inspected)`}; {c.transactionsDecoded} decoded, {c.failedTransactions} failed onchain (nothing moved).
      </p>
      {!r.complete && (
        <StatusMessage tone="warning" title="Partial sample">
          <ul>{issues.map((i) => <li key={i}>{i}.</li>)}</ul>
        </StatusMessage>
      )}

      {r.transfers.length === 0 ? (
        <p className="text-sm text-foreground">{r.complete ? "No qualifying native SOL transfers found in the inspected sample." : "No verified qualifying transfers in the available partial sample."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-subtle"><tr><th className="py-2 pr-4 font-normal">Direction</th><th className="py-2 pr-4 font-normal">Amount</th><th className="py-2 pr-4 font-normal">Counterparty</th><th className="py-2 pr-4 font-normal">Time (UTC)</th><th className="py-2 font-normal">Transaction</th></tr></thead>
            <tbody>
              {r.transfers.map((t) => {
                const other = t.direction === "IN" ? t.from : t.to;
                return (
                  <tr key={`${t.signature}:${t.outerIndex}:${t.innerIndex ?? "-"}`} className="border-t border-border font-mono">
                    <td className={`py-2 pr-4 ${t.direction === "IN" ? "text-primary" : "text-foreground"}`}>{DIR_LABEL[t.direction]}</td>
                    <td className="break-all py-2 pr-4 text-foreground">{t.sol} SOL<span className="block text-xs text-muted-foreground">{t.lamports} lamports</span></td>
                    <td className="py-2 pr-4">{t.direction === "SELF" ? <span className="text-muted-foreground">same address</span> : <a className="underline" href={`https://solscan.io/account/${encodeURIComponent(other)}`} target="_blank" rel="noreferrer" title={other}>{shortAddress(other)}</a>}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{t.blockTime !== null ? new Date(t.blockTime * 1000).toISOString().replace(".000Z", "Z") : `slot ${t.slot}`}</td>
                    <td className="py-2"><a className="underline" href={`https://solscan.io/tx/${encodeURIComponent(t.signature)}`} target="_blank" rel="noreferrer" title={t.signature}>{t.signature.slice(0, 8)}…</a>{t.innerIndex !== null && <span className="text-xs text-muted-foreground"> (inner)</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Fetched (UTC) {r.fetchedAt} — when MCPX asked. Only successful System Program transfers where this address is sender or recipient are counted; balance changes, fees, wrapped SOL, swaps and token transfers are not. Source: Solana mainnet via Helius ({r.commitment}).
      </p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
