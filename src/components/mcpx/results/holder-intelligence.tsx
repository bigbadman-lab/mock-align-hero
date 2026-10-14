// Result renderer shared by the Tool Library page and launched-product pages.
import { RouteError, StatusMessage } from "@/components/mcpx/primitives";
import { MintToolShell, NOT_MINT, PROGRAM_NAME } from "@/components/mcpx/MintToolShell";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { holderIntelligenceStatusQuery } from "@/lib/tools/status";
import { HI_CLIENT_TIMEOUT_MS, HI_ENDPOINT, type HolderIntelligenceResult, type OwnerKind } from "@/lib/tools/holder-intelligence";

const OWNER_KIND: Record<OwnerKind, string> = {
  system_account: "System account",
  program_owned: "Program-owned",
  no_account: "No account",
  unknown: "Unknown",
};
const pctText = (p: string | null) => (p === null ? "N/A" : `${p}%`);

export function HolderIntelligenceResultView({ r }: { r: HolderIntelligenceResult }) {
  const url = explorerAccountUrl(r.mint);
  const d = r.distribution;
  return (
    <section aria-labelledby="hi-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="hi-result" className="text-lg font-semibold text-foreground">Holder snapshot</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.mint}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</p>
      {r.status !== "mint" || !r.supply || !d ? (
        <StatusMessage tone="warning" title="Not a token mint"><p>{NOT_MINT[r.status] ?? "Not a token mint."}</p></StatusMessage>
      ) : (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div><dt className="text-subtle">Token</dt><dd className="text-foreground">{r.metadata?.status === "ok" ? `${r.metadata.name ?? "?"} (${r.metadata.symbol ?? "?"})` : "Name not read"}</dd></div>
            <div><dt className="text-subtle">Token program</dt><dd className="text-foreground">{r.program ? PROGRAM_NAME[r.program] : "Unavailable"}</dd></div>
            <div><dt className="text-subtle">Total supply (slot {r.supply.slot})</dt><dd className="break-all font-mono text-foreground">{r.supply.ui}</dd></div>
          </dl>
          {r.partial && (
            <StatusMessage tone="warning" title="Partial result">
              <p>Some parts couldn't be read ({r.warnings.map((w) => w.part.replace(/_/g, " ")).join(", ")}). Missing parts are shown as unknown, never as zero.</p>
            </StatusMessage>
          )}
          {d.status === "ok" && d.concentration && d.coverage && (
            <>
              <div className="space-y-2 text-sm">
                <h3 className="font-medium text-foreground">Concentration (share of total supply)</h3>
                <dl className="grid gap-3 sm:grid-cols-5">
                  {([["Largest account", d.concentration.largestAccountPct], ["Top 5 accounts", d.concentration.top5AccountsPct], ["Top 10 accounts", d.concentration.top10AccountsPct], ["Top 20 accounts", d.concentration.top20AccountsPct], ["Largest observed owner", d.concentration.largestObservedOwnerPct]] as const).map(([k, v]) => (
                    <div key={k} className="rounded-md border border-border p-3"><dt className="text-xs text-subtle">{k}</dt><dd className="font-mono text-foreground">{pctText(v)}</dd></div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Coverage: {d.coverage.observedAccounts} largest token accounts (max {d.coverage.maxAccounts}), holding {pctText(d.coverage.observedSharePct)} of supply. Owners resolved for {d.coverage.ownersResolved} of {d.coverage.observedAccounts}. Total number of holders: not counted.
                </p>
              </div>
              {d.owners.length > 0 && (
                <div className="space-y-2 text-sm">
                  <h3 className="font-medium text-foreground">Owner addresses behind those accounts</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-subtle"><tr><th className="py-2 pr-4 font-normal">Owner address</th><th className="py-2 pr-4 font-normal">Type</th><th className="py-2 pr-4 font-normal">Accounts</th><th className="py-2 pr-4 font-normal">Balance</th><th className="py-2 font-normal">Share</th></tr></thead>
                      <tbody>
                        {d.owners.map((o) => (
                          <tr key={o.owner} className="border-t border-border font-mono">
                            <td className="py-2 pr-4"><a className="underline" href={`https://solscan.io/account/${encodeURIComponent(o.owner)}`} target="_blank" rel="noreferrer" title={o.owner}>{shortAddress(o.owner)}</a></td>
                            <td className="py-2 pr-4 font-sans text-muted-foreground">{OWNER_KIND[o.ownerKind]}{o.onCurve === false ? " · PDA" : ""}</td>
                            <td className="py-2 pr-4 text-muted-foreground">{o.tokenAccounts}</td>
                            <td className="break-all py-2 pr-4 text-foreground">{o.ui}</td>
                            <td className="py-2 text-muted-foreground">{pctText(o.sharePct)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground">Grouped only within the accounts above — an owner may hold more elsewhere. "System account" means a regular wallet-style address, not proof of a person. "PDA" means the address is controlled by a program.</p>
                </div>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Show all {d.accounts.length} token accounts</summary>
                <ul className="mt-2 space-y-1 font-mono text-xs">
                  {d.accounts.map((a, i) => (
                    <li key={a.address} className="break-all text-muted-foreground">{i + 1}. {shortAddress(a.address)} — {a.ui} ({pctText(a.sharePct)}) · owner {a.owner ? shortAddress(a.owner) : a.ownerStatus === "missing" ? "account closed" : "not resolved"}{a.state === "frozen" ? " · frozen" : ""}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <p className="text-xs text-muted-foreground">{r.sameSlot ? "All reads observed the same slot." : "Reads observed different slots, so this is a near-time snapshot, not one atomic moment."} Percentages are rounded down to 4 decimal places.</p>
        </>
      )}
      <p className="text-xs text-muted-foreground">Observed (UTC) {r.observedAt} ({r.commitment}). Source: Solana mainnet via Helius — {r.methods.join(", ")} ({r.rpcCalls} calls).</p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
