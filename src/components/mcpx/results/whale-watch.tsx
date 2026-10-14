// Result renderer shared by the Tool Library page and launched-product pages.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { whaleWatchStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { WW_CLIENT_TIMEOUT_MS, WW_DEFAULT_THRESHOLD, WW_ENDPOINT, WW_THRESHOLDS, type WhaleWatchResult } from "@/lib/tools/whale-watch";

const DIR_LABEL = { IN: "In", OUT: "Out", SELF: "Self" } as const;

export function WhaleWatchResultView({ r }: { r: WhaleWatchResult }) {
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
