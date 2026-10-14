// Result renderer shared by the Tool Library page and launched-product pages.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { QUOTA_HELP, ToolErrorBox, ToolStatusBanner, postTool } from "@/components/mcpx/MintToolShell";
import { shortAddress } from "@/lib/wallet/state";
import { smartMoneyTrackerStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { SMT_CLIENT_TIMEOUT_MS, SMT_ENDPOINT, SMT_MAX_WALLETS, type Detail, type SmartMoneyResult, type SmtWallet } from "@/lib/tools/smart-money-tracker";

const DETAIL: Record<Detail, string> = { decoded: "decoded", partial: "partly decoded", failed_tx: "failed tx", unavailable: "couldn't read", unsupported_version: "unsupported format", budget: "time limit", not_inspected: "not inspected" };
const when = (t: number | null) => (t === null ? "time unknown" : new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC");

export function SmartMoneyResultView({ r }: { r: SmartMoneyResult }) {
  return (
    <section aria-labelledby="smt-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
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
