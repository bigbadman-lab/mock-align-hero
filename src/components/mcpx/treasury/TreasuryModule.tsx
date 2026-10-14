import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { overviewQuery, distributionsQuery } from "@/lib/treasury/queries";
import { formatUnits, formatUsd, lamportsToSol } from "@/lib/treasury/core";
import { CopyText, DISCLAIMER, ModeBadge, Stat, Updated, WindowClock, explorer } from "./parts";
import { buttonOutline } from "../primitives";

/** Compact homepage Treasury. Same data layer as /treasury. */
export function TreasuryModule() {
  const o = useQuery(overviewQuery);
  const d = useQuery(distributionsQuery({}));
  const v = o.data;
  return (
    <div className="rounded-lg border border-border bg-card p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="label-mono text-primary">MCPX Treasury</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h3 className="text-2xl font-semibold text-foreground">$MCP</h3>
            {v && <ModeBadge mode={v.mode} />}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {!v ? (o.isError ? "Treasury data unavailable right now." : "Loading…") : v.mint ? (
              <span className="inline-flex flex-wrap items-center gap-3">Mint <CopyText value={v.mint} label="mint address" />
                <a href={explorer("token", v.mint)} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-4 hover:text-primary">Explorer</a></span>
            ) : "Not launched — $MCP has not been minted. No mint address exists yet."}
          </div>
        </div>
        {v && <WindowClock o={v} />}
      </div>
      {v && (
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Market cap" value={v.market?.marketCapUsd != null ? formatUsd(v.market.marketCapUsd) : "—"} note={v.market ? `${v.market.source === "birdeye" ? "Birdeye" : "DexScreener"} · USD` : v.mint ? "No verified market yet" : "Not launched"} />
          <Stat label="24h volume" value={v.market ? formatUsd(v.market.volume24hUsd) : "—"} note={v.market ? "Exact mint pairs only" : undefined} />
          <Stat label="Fees collected" value={v.fees ? `${lamportsToSol(v.fees.collectedLamports)} SOL` : "—"} note="Finalized native creator fees" />
          <Stat label="Rewards settled" value={v.paid ? `${lamportsToSol(v.paid.solLamports)} SOL` : "—"} accent={!!v.paid && v.paid.solLamports !== "0"}
            note={v.paid && v.paid.tokenRaw !== "0" ? `+ ${formatUnits(v.paid.tokenRaw, v.paid.tokenDecimals ?? 0)} $MCP` : "Finalized payouts only"} />
        </div>
      )}
      <div className="mt-6 border-t border-border pt-4">
        <p className="label-mono text-[10px] text-subtle">Recent distributions</p>
        {d.data?.rows.length ? (
          <ul className="mt-2 space-y-1">{d.data.rows.slice(0, 3).map((r) => (
            <li key={r.id} className="flex justify-between font-mono text-xs"><span className="text-muted-foreground">{r.recipient.slice(0, 4)}…{r.recipient.slice(-4)}</span>
              <a className="text-foreground hover:text-primary" href={explorer("tx", r.signature)} target="_blank" rel="noreferrer">{formatUnits(r.amountRaw, r.decimals)} {r.asset === "SOL" ? "SOL" : "$MCP"}</a></li>))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted-foreground">No finalized distributions yet.</p>}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-subtle">{DISCLAIMER}</p>
        <div className="flex items-center gap-4"><Updated at={v?.asOf} stale={o.isError && !!v} /><Link to="/treasury" className={buttonOutline}>Open Treasury</Link></div>
      </div>
    </div>
  );
}
