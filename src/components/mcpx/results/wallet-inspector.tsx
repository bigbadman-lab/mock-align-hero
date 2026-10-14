// Result renderer shared by the Tool Library page and launched-product pages.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { walletInspectorStatusQuery } from "@/lib/tools/status";
import { WI_CLIENT_TIMEOUT_MS, WI_ENDPOINT, isValidSolanaAddress, type ToolErrorKind, type WalletInspectorResult } from "@/lib/tools/wallet-inspector";

const PROGRAM_LABEL: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
};
const PAGE = 50;
export function WalletInspectorResultView({ r }: { r: WalletInspectorResult }) {
  const [shown, setShown] = useState(PAGE);
  const url = explorerAccountUrl(r.address);
  const tokensKnown = r.coverage.splToken && r.coverage.token2022;
  return (
    <section aria-labelledby="wi-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="wi-result" className="text-lg font-semibold text-foreground">Result <span className="font-mono text-sm text-muted-foreground">{shortAddress(r.address)}</span></h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      {r.partial && (
        <StatusMessage tone="warning" title="Partial result">
          <ul>{r.warnings.map((w) => <li key={w.part}>{w.message}</li>)}</ul>
          <p>Missing parts are unknown, not zero.</p>
        </StatusMessage>
      )}
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-subtle">Address</dt><dd className="break-all font-mono text-foreground">{r.address}{url && <> · <a href={url} target="_blank" rel="noreferrer" className="underline">Solscan</a></>}</dd></div>
        <div><dt className="text-subtle">SOL balance</dt><dd className="font-mono text-foreground">{r.solBalance ? `${r.solBalance.solUi} SOL (${r.solBalance.lamports} lamports)` : "Unavailable"}</dd></div>
        <div><dt className="text-subtle">Fetched (UTC)</dt><dd className="font-mono text-foreground">{r.fetchedAt}</dd></div>
        <div><dt className="text-subtle">Observed slots ({r.commitment})</dt><dd className="font-mono text-foreground">balance {r.sourceSlots.balance ?? "n/a"} · SPL {r.sourceSlots.splToken ?? "n/a"} · Token-2022 {r.sourceSlots.token2022 ?? "n/a"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Source: {r.source}. Queries may observe different slots; this is not one atomic snapshot. Shows currently open token accounts only — no history, prices or token names.</p>
      <div>
        <h3 className="mb-3 text-sm font-medium text-foreground">Token holdings ({r.tokenHoldings.length} mints)</h3>
        {r.tokenHoldings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tokensKnown ? "No open token accounts on SPL Token or Token-2022." : "Token holdings could not be fully checked."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-subtle"><tr><th className="py-2 pr-4 font-normal">Mint</th><th className="py-2 pr-4 font-normal">Amount</th><th className="py-2 pr-4 font-normal">Raw · decimals</th><th className="py-2 pr-4 font-normal">Program</th><th className="py-2 font-normal">Accounts</th></tr></thead>
              <tbody>
                {r.tokenHoldings.slice(0, shown).map((h) => (
                  <tr key={h.program + h.mint} className="border-t border-border font-mono">
                    <td className="py-2 pr-4"><a href={`https://solscan.io/token/${encodeURIComponent(h.mint)}`} target="_blank" rel="noreferrer" className="underline" title={h.mint}>{shortAddress(h.mint)}</a></td>
                    <td className="py-2 pr-4 text-foreground">{h.amountUi}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{h.amountRaw} · {h.decimals}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{PROGRAM_LABEL[h.program] ?? h.program}</td>
                    <td className="py-2 text-muted-foreground">{h.tokenAccounts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown < r.tokenHoldings.length && <button className={`${buttonOutline} mt-4`} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, r.tokenHoldings.length - shown)} more</button>}
          </div>
        )}
      </div>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
