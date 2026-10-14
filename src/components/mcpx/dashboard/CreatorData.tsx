// Earnings / Native rewards / Tool activity for the verified creator. One GET, session-scoped server-side.
import { useEffect, useState, type ReactNode } from "react";
import { Activity, Coins, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatUnits, lamportsToSol, short } from "@/lib/treasury/core";
import type { ActivityData, ActivityItem, EarningRow, EarningsData, QuoteAsset, RewardsData, SectionState } from "@/lib/creator-dashboard/core";
import { useCreatorSessionContext } from "@/lib/creator-auth/session-context";

type Payload = { earnings: SectionState<EarningsData>; rewards: SectionState<RewardsData>; activity: SectionState<ActivityData> };
const tx = (sig: string) => `https://solscan.io/tx/${encodeURIComponent(sig)}`;
const when = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Human amount only when decimals are verified; otherwise explicitly raw units. */
function amount(raw: string, a: QuoteAsset | undefined, mint: string) {
  if (!a || a.decimals === null) return `${raw} raw units · ${short(mint)}`;
  return `${formatUnits(raw, a.decimals)} ${a.symbol ?? short(mint)}`;
}

export function CreatorData() {
  const session = useCreatorSessionContext();
  const wallet = session.s === "signed_in" ? session.wallet : null;
  const [d, setD] = useState<Payload | "loading" | "error">("loading");
  useEffect(() => {
    if (!wallet) return;
    let live = true;
    setD("loading");
    fetch("/api/creator/dashboard", { credentials: "same-origin" }).then(async (r) => {
      if (!live) return;
      if (r.status === 401) return session.ended("Your session ended. Verify again to continue.");
      setD(r.ok ? ((await r.json()) as Payload) : "error");
    }).catch(() => live && setD("error"));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  const all = <K extends keyof Payload>(k: K): Payload[K] | "loading" => (d === "loading" ? "loading" : d === "error" ? ({ state: "unavailable" } as Payload[K]) : d[k]);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card id="d-earn" icon={<Coins className="h-5 w-5" />} title="Creator earnings" s={all("earnings")}
        copy={{ not_launched: "No verified token launch yet. Your 60% creator-fee share appears here once a launched token earns fees.", no_activity: "No fee distributions have settled for your tokens yet." }}>
        {(e: EarningsData) => <Earnings key={wallet} e={e} />}
      </Card>
      <Card id="d-rew" icon={<LayoutGrid className="h-5 w-5" />} title="Native $MCP rewards" s={all("rewards")}
        copy={{ not_launched: "$MCP has not launched yet. Rewards paid to this wallet appear here once it does.", no_activity: "No confirmed reward payouts to this wallet yet." }}>
        {(r: RewardsData) => <Rewards r={r} />}
      </Card>
      <Card id="d-act" icon={<Activity className="h-5 w-5" />} title="Tool activity" s={all("activity")}
        copy={{ not_launched: "Activity appears after one of your tokens launches and its MCP product is verified.", no_activity: "No runs of your MCP products in the last 90 days." }}>
        {(a: ActivityData) => <ActivityList key={wallet} a={a} />}
      </Card>
    </div>
  );
}

function Card<T>({ id, icon, title, s, copy, children }: { id: string; icon: ReactNode; title: string; s: SectionState<T> | "loading"; copy: { not_launched: string; no_activity: string }; children: (d: T) => ReactNode }) {
  const tag = s === "loading" ? null : ({ ok: "Live", not_launched: "Not launched", no_activity: "No activity yet", not_tracked: "Tracking not yet available", unavailable: "Temporarily unavailable" } as const)[s.state];
  return (
    <section aria-labelledby={id} aria-busy={s === "loading"} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span aria-hidden className={s !== "loading" && s.state === "ok" ? "text-primary" : "text-subtle"}>{icon}</span>
        {tag && <span className={`font-mono text-[11px] uppercase tracking-wider ${s !== "loading" && s.state === "unavailable" ? "text-warning" : "text-subtle"}`}>{tag}</span>}
      </div>
      <h2 id={id} className="text-sm font-semibold text-foreground">{title}</h2>
      {s === "loading" ? <div className="h-12 animate-pulse rounded-md bg-surface-2" />
        : s.state === "ok" ? children(s.data)
        : <p className="text-xs leading-relaxed text-muted-foreground">
            {s.state === "unavailable" ? "Couldn't load this right now. Reload to try again." : s.state === "not_tracked" ? s.reason : copy[s.state]}
          </p>}
    </section>
  );
}

/** Cursor-paged list; a failed page shows an inline error and keeps what's already loaded. */
function useMore<T>(path: string, initial: T[], cursor0: string | null, pick: (j: unknown) => { rows: T[]; nextCursor: string | null }) {
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(cursor0);
  const [st, setSt] = useState<"idle" | "loading" | "error">("idle");
  const more = async () => {
    if (!cursor) return;
    setSt("loading");
    try {
      const r = await fetch(`${path}?cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      const j = pick(await r.json());
      setRows((x) => { const ids = new Set(x.map((v) => JSON.stringify(v))); return [...x, ...j.rows.filter((v) => !ids.has(JSON.stringify(v)))]; });
      setCursor(j.nextCursor); setSt("idle");
    } catch { setSt("error"); }
  };
  return { rows, cursor, st, more };
}

function More({ st, onClick }: { st: "idle" | "loading" | "error"; onClick: () => void }) {
  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" className="w-full" disabled={st === "loading"} onClick={onClick}>{st === "loading" ? "Loading…" : "Load more"}</Button>
      {st === "error" && <p className="text-xs text-warning">Couldn't load older records. Try again.</p>}
    </div>
  );
}

function Earnings({ e }: { e: EarningsData }) {
  const [assets, setAssets] = useState(e.assets);
  const m = useMore<EarningRow>("/api/creator/dashboard/earnings", e.rows, e.nextCursor, (j) => {
    const p = j as { rows: EarningRow[]; nextCursor: string | null; assets: Record<string, QuoteAsset> };
    setAssets((a) => ({ ...a, ...p.assets }));
    return p;
  });
  return (
    <div className="space-y-3 text-xs">
      {e.totals.map((t) => (
        <p key={t.quoteMint} className="break-words font-mono text-base text-foreground">{amount(t.creatorShareRaw, assets[t.quoteMint], t.quoteMint)}</p>
      ))}
      <p className="text-muted-foreground">Your 60% share of confirmed fee distributions, paid on-chain directly to your wallet. Nothing to claim.</p>
      {!e.totalsComplete && <p className="text-muted-foreground">Total covers your most recent 2,000 confirmed distributions.</p>}
      {e.pendingIntents > 0 && <p className="text-muted-foreground">{e.pendingIntents} distribution{e.pendingIntents > 1 ? "s" : ""} awaiting on-chain confirmation (not counted).</p>}
      <ul className="divide-y divide-border">
        {m.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span className="text-foreground">{r.productName}</span>
            <a href={tx(r.signature)} target="_blank" rel="noopener noreferrer" className="font-mono text-subtle underline-offset-2 hover:underline">{amount(r.creatorShareRaw, assets[r.quoteMint], r.quoteMint)} · {when(r.at)}</a>
          </li>
        ))}
      </ul>
      {m.cursor && <More st={m.st} onClick={m.more} />}
    </div>
  );
}

function Rewards({ r }: { r: RewardsData }) {
  return (
    <div className="space-y-3 text-xs">
      <dl className="grid grid-cols-2 gap-2">
        <div><dt className="text-subtle">SOL received</dt><dd className="font-mono text-base text-foreground">{lamportsToSol(r.solRaw)}</dd></div>
        <div><dt className="text-subtle">$MCP received</dt><dd className="font-mono text-base text-foreground">{r.mcpDecimals === null ? "—" : formatUnits(r.mcpRaw, r.mcpDecimals)}</dd></div>
      </dl>
      <p className="text-muted-foreground">Confirmed on-chain payouts only.{r.limited ? " Totals cover the most recent payout records; older payouts are not included." : ""}</p>
      <ul className="divide-y divide-border">
        {r.rows.slice(0, 10).map((p) => (
          <li key={p.id} className="flex justify-between gap-2 py-2">
            <span className="text-foreground">{p.asset === "SOL" ? `${lamportsToSol(p.amountRaw)} SOL` : `${formatUnits(p.amountRaw, p.decimals)} $MCP`}</span>
            <a href={tx(p.signature)} target="_blank" rel="noopener noreferrer" className="font-mono text-subtle hover:underline">slot {p.finalizedSlot}</a>
          </li>
        ))}
      </ul>
      {r.rows.length > 10 && <p className="text-muted-foreground">Showing your latest 10 payouts.</p>}
    </div>
  );
}

function ActivityList({ a }: { a: ActivityData }) {
  const m = useMore<ActivityItem>("/api/creator/dashboard/activity", a.rows, a.nextCursor, (j) => j as { rows: ActivityItem[]; nextCursor: string | null });
  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">Runs of your MCP products by external clients, last {a.retentionDays} days. Website demos are not counted.</p>
      <ul className="divide-y divide-border">
        {m.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span className="text-foreground">{r.productName} <span className="font-mono text-subtle">{r.toolId}</span></span>
            <span className={`font-mono ${r.outcome === "ok" ? "text-subtle" : "text-warning"}`}>{r.outcome === "ok" ? "OK" : "Failed"} · {when(r.at)}</span>
          </li>
        ))}
      </ul>
      {m.cursor && <More st={m.st} onClick={m.more} />}
    </div>
  );
}
