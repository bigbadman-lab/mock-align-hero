import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageContainer, PageHeader, RouteError, SectionHeading, EmptyState } from "@/components/mcpx/primitives";
import { CopyText, DISCLAIMER, ModeBadge, Stat, Updated, WindowClock, explorer } from "@/components/mcpx/treasury/parts";
import { childQuery, distributionsQuery, overviewQuery, windowsQuery } from "@/lib/treasury/queries";
import { B58, CHILD_SPLIT, SPLIT, formatUnits, formatUsd, lamportsToSol, short, type DistributionRow } from "@/lib/treasury/core";
import { useWallet } from "@/lib/wallet/context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/treasury")({
  head: () => ({
    meta: [
      { title: "Treasury — MCPX" },
      { name: "description", content: "Native $MCP fees, five-minute holder reward windows and finalized distributions — verified data only." },
      { property: "og:title", content: "MCPX Treasury" },
      { property: "og:description", content: "Native $MCP fee collection, 30/30/40 allocation and finalized holder payouts. No APY, no guarantees." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Treasury,
  errorComponent: RouteError,
});

function Treasury() {
  const o = useQuery(overviewQuery);
  const v = o.data;
  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Treasury" title="MCPX Treasury" intro="Native $MCP fees, reward windows and finalized holder payouts. Every number comes from finalized on-chain records; nothing is estimated." />
      <PageContainer className="space-y-8 py-6">
        {!v ? <p className="text-sm text-muted-foreground">{o.isError ? "Treasury data is unavailable right now. Retrying automatically." : "Loading treasury…"}</p> : (
          <>
            <section aria-labelledby="t-token" className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-center gap-3"><h2 id="t-token" className="text-xl font-semibold text-foreground">$MCP</h2><ModeBadge mode={v.mode} /></div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <Row k="Mint">{v.mint ? <span className="inline-flex gap-3"><CopyText value={v.mint} label="mint address" /><a className="underline decoration-border underline-offset-4 hover:text-primary" href={explorer("token", v.mint)} target="_blank" rel="noreferrer">Explorer</a></span> : "Not minted yet"}</Row>
                  <Row k="Chain / program">{v.tokenProgram === "token-2022" ? "Solana · Token-2022" : v.tokenProgram === "spl-token" ? "Solana · SPL Token" : v.mint ? "Solana · program not yet verified" : "—"}</Row>
                  <Row k="Status">{v.mode === "PRELAUNCH" ? "Not launched" : v.mode === "REHEARSAL" ? "Rehearsal mint — not production $MCP" : "Configured canonical mint"}</Row>
                  <Row k="Holders">{v.holderCount ? `${v.holderCount.count.toLocaleString()} (slot ${v.holderCount.slot})` : "—"}</Row>
                </dl>
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Price" value={v.market?.priceUsd ? `$${Number(v.market.priceUsd).toPrecision(4)}` : "—"} />
                  <Stat label="Market cap" value={v.market?.marketCapUsd != null ? formatUsd(v.market.marketCapUsd) : "—"} note="As reported by provider" />
                  <Stat label="FDV" value={v.market?.fdvUsd != null ? formatUsd(v.market.fdvUsd) : "—"} note="Fully diluted — not market cap" />
                  <Stat label="24h volume" value={v.market ? formatUsd(v.market.volume24hUsd) : "—"} />
                </div>
                <p className="mt-3 text-[11px] text-subtle">{v.market ? `Source: ${v.market.source === "birdeye" ? "Birdeye" : "DexScreener"}, ${v.market.pairCount} market(s) for this exact mint · USD · fetched ${new Date(v.market.fetchedAt).toUTCString().slice(17, 25)} UTC` : v.marketError ? "Market data provider unavailable — values hidden, not zero." : v.mint ? "No market pairs found for this exact mint yet." : "Market data appears once $MCP is minted."}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <WindowClock o={v} large />
                <dl className="mt-3 space-y-2 text-sm">
                  <Row k="Last processed window">{v.windows.lastProcessed ? `${utc(v.windows.lastProcessed)} · ${v.windows.lastProcessedOutcome?.toLowerCase()}` : "None yet"}</Row>
                  <Row k="Last finalized payout">{v.windows.lastFinalizedPayout ? utc(v.windows.lastFinalizedPayout) : "None yet"}</Row>
                  <Row k="Worker heartbeat">{v.windows.heartbeatAt ? utc(v.windows.heartbeatAt) : "No processing yet"}</Row>
                </dl>
                <p className="mt-4 text-[11px] text-subtle">Windows close every five minutes (UTC). A window closing does not mean anyone was paid — only finalized payouts below count.</p>
              </div>
            </section>

            <section aria-labelledby="t-alloc">
              <SectionHeading label="Allocation" title={<span id="t-alloc">Native fee model: {SPLIT.holderSol} / {SPLIT.buyback} / {SPLIT.operations}</span>}
                intro={`Of finalized collected $MCP creator fees: ${SPLIT.holderSol}% paid to holders in SOL, ${SPLIT.buyback}% buys $MCP that is distributed to holders, ${SPLIT.operations}% protocol operations. Pump.fun built-in holder rewards are off.`} />
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Collected" value={v.fees ? `${lamportsToSol(v.fees.collectedLamports)} SOL` : "—"} note={v.fees ? `${v.fees.events} finalized fee event(s)` : "Not launched"} />
                <Stat label="Allocated to holders (SOL)" value={v.allocation ? `${lamportsToSol(v.allocation.holderSolLamports)} SOL` : "—"} />
                <Stat label="Allocated to buyback" value={v.allocation ? `${lamportsToSol(v.allocation.buybackLamports)} SOL` : "—"} />
                <Stat label="Operations" value={v.allocation ? `${lamportsToSol(v.allocation.operationsLamports)} SOL` : "—"} />
                <Stat label="Finalized SOL payouts" value={v.paid ? `${lamportsToSol(v.paid.solLamports)} SOL` : "—"} accent />
                <Stat label="Buyback spend" value={v.buyback ? `${lamportsToSol(v.buyback.solSpentLamports)} SOL` : "—"} note={v.buyback ? `${v.buyback.fills} finalized fill(s)` : undefined} />
                <Stat label="Verified $MCP acquired" value={v.buyback ? `${formatUnits(v.buyback.tokenAcquiredRaw, v.paid?.tokenDecimals ?? 0)}` : "—"} />
                <Stat label="Verified $MCP distributed" value={v.paid ? formatUnits(v.paid.tokenRaw, v.paid.tokenDecimals ?? 0) : "—"} accent />
              </div>
              <p className="mt-3 text-[11px] text-subtle">SOL and $MCP are shown separately and never added together. Accrued (uncollected) fees are not shown because they are not yet provable. {DISCLAIMER}</p>
            </section>

            <Distributions />
            <Windows />
            <Child />
            <Updated at={v.asOf} stale={o.isError} />
          </>
        )}
      </PageContainer>
    </>
  );
}

function Distributions() {
  const w = useWallet();
  const [asset, setAsset] = useState<"" | "SOL" | "MCP">("");
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const [pages, setPages] = useState<number[]>([0]);
  const wallet = mine && w.address ? w.address : B58.test(search.trim()) ? search.trim() : undefined;
  return (
    <section aria-labelledby="t-dist">
      <SectionHeading label="Live feed" title={<span id="t-dist">Finalized holder distributions</span>} intro="Only payouts proven by a finalized on-chain transaction. Reserved, signed or sent-but-unproven payments never appear here." />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPages([0]); }} placeholder="Search a wallet address" aria-label="Search by wallet address"
          className="h-10 w-full max-w-sm rounded-md border border-border bg-background px-3 font-mono text-xs text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        {(["", "SOL", "MCP"] as const).map((a) => (
          <button key={a || "all"} type="button" onClick={() => { setAsset(a); setPages([0]); }} aria-pressed={asset === a}
            className={cn("h-10 rounded-md border px-3 font-mono text-xs", asset === a ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{a === "" ? "All" : a === "SOL" ? "SOL" : "$MCP"}</button>
        ))}
        {w.address && <button type="button" onClick={() => { setMine(!mine); setPages([0]); }} aria-pressed={mine}
          className={cn("h-10 rounded-md border px-3 font-mono text-xs", mine ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground")}>Your rewards</button>}
      </div>
      {mine && <p className="mt-2 text-[11px] text-subtle">Finalized receipts for the connected wallet, from the same public ledger. No projections.</p>}
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-secondary/40 font-mono text-[10px] uppercase tracking-wider text-subtle"><tr><th className="p-3">Window (UTC)</th><th className="p-3">Recipient</th><th className="p-3">Asset</th><th className="p-3 text-right">Amount</th><th className="p-3">Transaction</th><th className="p-3">Finalized slot</th></tr></thead>
          {pages.map((p, i) => <DistPage key={p} asset={asset || undefined} wallet={wallet} beforeSlot={p || undefined} last={i === pages.length - 1} onMore={(s) => setPages([...pages, s])} />)}
        </table>
      </div>
    </section>
  );
}

function DistPage({ asset, wallet, beforeSlot, last, onMore }: { asset?: "SOL" | "MCP" | undefined; wallet?: string | undefined; beforeSlot?: number | undefined; last: boolean; onMore: (s: number) => void }) {
  const q = useQuery(distributionsQuery({ asset, wallet, beforeSlot }));
  const rows: DistributionRow[] = q.data?.rows ?? [];
  return (
    <tbody aria-live={beforeSlot ? undefined : "polite"}>
      {rows.map((r) => (
        <tr key={r.id} className="border-t border-border animate-in fade-in">
          <td className="p-3 font-mono text-muted-foreground">{r.windowStart ? utc(r.windowStart) : "—"}</td>
          <td className="p-3"><CopyText value={r.recipient} label="recipient" /></td>
          <td className="p-3 font-mono">{r.asset === "SOL" ? "SOL" : "$MCP"}</td>
          <td className="p-3 text-right font-mono text-foreground">{formatUnits(r.amountRaw, r.decimals, r.decimals)}</td>
          <td className="p-3"><a href={explorer("tx", r.signature)} target="_blank" rel="noreferrer" className="font-mono text-foreground underline decoration-border underline-offset-4 hover:text-primary">{short(r.signature, 6)}</a></td>
          <td className="p-3 font-mono text-muted-foreground">{r.finalizedSlot}</td>
        </tr>
      ))}
      {!beforeSlot && !rows.length && (
        <tr><td colSpan={6} className="p-4 text-center text-sm text-muted-foreground">{q.isPending ? "Loading…" : q.isError ? "Distributions unavailable right now — retrying." : wallet ? "No finalized distributions for this wallet." : "No finalized distributions yet. Payouts appear here only after they land on-chain."}</td></tr>
      )}
      {last && q.data?.nextBeforeSlot && (
        <tr><td colSpan={6} className="p-3 text-center"><button type="button" onClick={() => onMore(q.data!.nextBeforeSlot!)} className="font-mono text-xs text-primary underline underline-offset-4">Load older</button></td></tr>
      )}
    </tbody>
  );
}

function Windows() {
  const [range, setRange] = useState<"24h" | "7d" | "all">("24h");
  const q = useQuery(windowsQuery(range));
  return (
    <section aria-labelledby="t-win">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading label="History" title={<span id="t-win">Reward windows</span>} intro="Each five-minute window's outcome, including empty and held windows." />
        <div className="flex gap-2">{(["24h", "7d", "all"] as const).map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={cn("h-9 rounded-md border px-3 font-mono text-xs", range === r ? "border-primary text-primary" : "border-border text-muted-foreground")}>{r === "all" ? "All time" : r}</button>))}</div>
      </div>
      <div className="mt-4 space-y-2">
        {q.data?.rows.length ? q.data.rows.map((w) => (
          <div key={w.windowStart} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
            <span className="text-muted-foreground">{utc(w.windowStart)}</span>
            <span className={w.status === "HELD" ? "text-warning" : "text-foreground"}>{w.label}</span>
            <span className="text-subtle">{w.rewardsLamports !== "0" ? `${lamportsToSol(w.rewardsLamports)} SOL planned` : ""}</span>
          </div>
        )) : <EmptyState title={q.isError ? "Window history unavailable" : "No windows processed yet"}>{q.isError ? "Retrying automatically." : "Windows are recorded once $MCP is minted and the rewards worker starts processing."}</EmptyState>}
      </div>
    </section>
  );
}

function Child() {
  const q = useQuery(childQuery);
  const c = q.data;
  return (
    <section aria-labelledby="t-child">
      <SectionHeading label="Separate ledger" title={<span id="t-child">Child token ecosystem</span>}
        intro={`Child tool tokens have their own on-chain locked split of collected creator fees: ${CHILD_SPLIT.creator}% creator / ${CHILD_SPLIT.ops}% tool operations / ${CHILD_SPLIT.platform}% MCPX platform. Never mixed with native $MCP fees or holder rewards.`} />
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Verified launched products" value={c ? c.verifiedProducts : "—"} note="Counted only after launch verification" />
        <Stat label="Finalized fee distributions" value={c ? c.distributions : "—"} />
        <Stat label="Child trade volume" value="—" note="No verified source yet" />
      </div>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div><dt className="label-mono text-[10px] text-subtle">{k}</dt><dd className="mt-1 text-foreground">{children}</dd></div>;
}
const utc = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 16);
