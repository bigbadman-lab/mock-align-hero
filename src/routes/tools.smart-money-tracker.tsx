import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { QUOTA_HELP, ToolErrorBox, ToolStatusBanner, postTool } from "@/components/mcpx/MintToolShell";
import { shortAddress } from "@/lib/wallet/state";
import { smartMoneyTrackerStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { SMT_CLIENT_TIMEOUT_MS, SMT_ENDPOINT, SMT_MAX_WALLETS, type Detail, type SmartMoneyResult, type SmtWallet } from "@/lib/tools/smart-money-tracker";

export const Route = createFileRoute("/tools/smart-money-tracker")({
  head: () => ({
    meta: [
      { title: "Smart Money Tracker — MCPX" },
      { name: "description", content: "On-demand recent activity for up to 3 Solana wallets you choose: signatures and native SOL transfers, larger moves highlighted. Not monitoring." },
      { property: "og:title", content: "Smart Money Tracker — MCPX" },
      { property: "og:description", content: "Tracked wallet activity for wallets you pick — bounded, sourced, read-only." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  errorComponent: RouteError,
});

function Page() {
  const status = useQuery(smartMoneyTrackerStatusQuery);
  const [inputs, setInputs] = useState(["", "", ""]);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (wallets: string[]) => { abort.current?.abort(); abort.current = new AbortController(); return postTool<SmartMoneyResult>(SMT_ENDPOINT, { wallets }, abort.current.signal, SMT_CLIENT_TIMEOUT_MS); },
    retry: false,
  });
  const filled = inputs.map((s) => s.trim()).filter(Boolean);
  const invalid = filled.filter((a) => !isValidSolanaAddress(a));
  const dup = new Set(filled).size !== filled.length;
  const ok = filled.length >= 1 && invalid.length === 0 && !dup;
  const available = status.data?.available === true;

  return (
    <>
      <PageHeader label="Template tool · Intelligence" title="Smart Money Tracker" intro="Tracked wallet activity for up to 3 wallets you choose — recent signatures and native SOL transfers, read once when you press the button." />
      <PageContainer className="space-y-10 py-12">
        <p className="max-w-2xl text-sm text-muted-foreground">Not a 24/7 monitor, alert or copy-trading tool, and it doesn't say whether these wallets are "smart". It samples the latest 20 signatures per wallet and decodes the newest 5; token transfers, swaps and profit are not shown.</p>
        <ToolStatusBanner name="Smart Money Tracker" status={status} />
        {available && (
          <form onSubmit={(e) => { e.preventDefault(); if (ok && !run.isPending) run.mutate(filled); }} className="max-w-2xl space-y-3" noValidate>
            {inputs.map((v, i) => (
              <div key={i}>
                <label htmlFor={`smt-${i}`} className="label-mono block text-xs text-subtle">Wallet {i + 1}{i > 0 ? " (optional)" : ""}</label>
                <input id={`smt-${i}`} value={v} onChange={(e) => setInputs((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} maxLength={60} autoComplete="off" spellCheck={false}
                  aria-invalid={!!v.trim() && !isValidSolanaAddress(v.trim())}
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface-2 px-4 py-3 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary" placeholder="Base58 wallet address" />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {invalid.length ? <span className="text-warning">{invalid.length} address{invalid.length > 1 ? "es aren't" : " isn't"} a valid Solana public key.</span> : dup ? <span className="text-warning">The same wallet is entered twice.</span> : `Up to ${SMT_MAX_WALLETS} wallets; one check = one free test. ${QUOTA_HELP}`}
            </p>
            <button type="submit" className={buttonPrimary} disabled={!ok || run.isPending}>{run.isPending ? "Checking…" : "Track Wallets"}</button>
          </form>
        )}
        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isError && <ToolErrorBox error={run.error} onRetry={() => run.variables && run.mutate(run.variables)} />}
          {run.data && !run.isPending && <Result r={run.data} />}
        </div>
        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

const DETAIL: Record<Detail, string> = { decoded: "decoded", partial: "partly decoded", failed_tx: "failed tx", unavailable: "couldn't read", unsupported_version: "unsupported format", budget: "time limit", not_inspected: "not inspected" };
const when = (t: number | null) => (t === null ? "time unknown" : new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC");

function Result({ r }: { r: SmartMoneyResult }) {
  return (
    <section aria-labelledby="smt-result" className="space-y-6 rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="smt-result" className="text-lg font-semibold text-foreground">Tracked wallet activity</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet · finalized</span>
      </div>
      {!r.complete && <StatusMessage tone="warning" title="Partial sample"><p>Some transactions couldn't be read in time or at all. They're listed as such — nothing is filled in.</p></StatusMessage>}
      {r.wallets.map((w) => <WalletBlock key={w.address} w={w} hiSol={r.limits.highlightSol} />)}
      <p className="text-xs text-muted-foreground">{r.scope} Highlights = native SOL transfers ≥ {r.limits.highlightSol} SOL (fixed). Observed {r.fetchedAt}. Source: Solana mainnet via Helius ({r.rpcCalls} calls).</p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}

function WalletBlock({ w, hiSol }: { w: SmtWallet; hiSol: string }) {
  return (
    <div className="space-y-3 border-t border-border pt-4 text-sm">
      <h3 className="break-all font-mono text-foreground"><a className="underline" href={`https://solscan.io/account/${encodeURIComponent(w.address)}`} target="_blank" rel="noreferrer">{w.address}</a></h3>
      {w.status !== "ok" ? <p className="text-warning">Recent signatures couldn't be read ({w.reason}). Nothing is shown for this wallet.</p> : w.signatures.length === 0 ? <p className="text-muted-foreground">No recent transactions found.</p> : (
        <>
          <p className="text-muted-foreground">{w.counts.signaturesSeen} recent signatures ({when(w.window.oldestBlockTime)} → {when(w.window.newestBlockTime)}), {w.counts.failedTransactions} failed. Decoded {w.counts.decoded}; {w.counts.notInspected} not inspected.</p>
          <p className="text-foreground">{w.highlights.length ? `${w.highlights.length} transfer${w.highlights.length > 1 ? "s" : ""} ≥ ${hiSol} SOL:` : `No native SOL transfers ≥ ${hiSol} SOL in the decoded transactions.`}</p>
          {w.transfers.length > 0 && (
            <ul className="space-y-1 font-mono text-xs">
              {w.transfers.map((t, i) => <li key={t.signature + i} className="break-all text-muted-foreground">{t.direction} {t.sol} SOL · {t.direction === "OUT" ? `to ${shortAddress(t.to)}` : `from ${shortAddress(t.from)}`} · <a className="underline" href={`https://solscan.io/tx/${encodeURIComponent(t.signature)}`} target="_blank" rel="noreferrer">{shortAddress(t.signature)}</a></li>)}
            </ul>
          )}
          <details><summary className="cursor-pointer text-muted-foreground">All {w.signatures.length} signatures</summary>
            <ul className="mt-2 space-y-1 font-mono text-xs">{w.signatures.map((s) => <li key={s.signature} className="break-all text-muted-foreground"><a className="underline" href={`https://solscan.io/tx/${encodeURIComponent(s.signature)}`} target="_blank" rel="noreferrer">{shortAddress(s.signature)}</a> · slot {s.slot} · {when(s.blockTime)} · {s.succeeded ? "ok" : "failed"} · {DETAIL[s.detail]}</li>)}</ul>
          </details>
        </>
      )}
    </div>
  );
}
