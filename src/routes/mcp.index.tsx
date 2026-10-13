import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { accountCheckerStatusQuery, whaleWatchStatusQuery, supplyMonitorStatusQuery, tokenScannerStatusQuery, transactionVerifierStatusQuery, walletInspectorStatusQuery } from "@/lib/tools/status";
import { PageContainer, PageHeader, RouteError } from "@/components/mcpx/primitives";
import { LIBRARY, LIBRARY_CATEGORIES, type LibraryCategory, type LibraryTemplate } from "@/lib/templates";
import { cn } from "@/lib/utils";

// Explicit toolId → status query mapping (relay ids are not derived from catalogue ids).
const STATUS = {
  wallet_inspector: walletInspectorStatusQuery,
  whale_watch: whaleWatchStatusQuery,
  token_scanner: tokenScannerStatusQuery,
  supply_monitor: supplyMonitorStatusQuery,
  transaction_verifier: transactionVerifierStatusQuery,
  account_checker: accountCheckerStatusQuery,
} as const;

export const Route = createFileRoute("/mcp/")({
  head: () => ({
    meta: [
      { title: "Tool Library — MCPX" },
      { name: "description", content: "Ten MCPX tool templates for Solana wallets, tokens, verification and intelligence, with live availability." },
      { property: "og:title", content: "Tool Library — MCPX" },
      { property: "og:description", content: "Browse ten Solana MCP tool templates. Live links appear only when a tool's execution service reports ready." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: McpPage,
  errorComponent: RouteError,
});

type Filter = "All" | LibraryCategory;

function McpPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Filter>("All");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return LIBRARY.filter((t) => (cat === "All" || t.category === cat) && (!s || `${t.name} ${t.tagline} ${t.benefit} ${t.category}`.toLowerCase().includes(s)));
  }, [q, cat]);

  return (
    <>
      <PageHeader label="Tool library" title="Ten MCP templates" intro="Read-only Solana tools. Each card shows what is actually available today: running the tool, using it over MCP, and launching it as a token." />
      <PageContainer className="py-12">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
            {(["All", ...LIBRARY_CATEGORIES] as Filter[]).map((c) => (
              <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)}
                className={cn("min-h-9 rounded-md border px-3 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  cat === c ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground")}>
                {c}
              </button>
            ))}
          </div>
          <label className="relative block md:w-72">
            <span className="sr-only">Search templates</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates"
              className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
        </div>
        <p className="mt-4 font-mono text-xs text-subtle" aria-live="polite">{list.length} of {LIBRARY.length} templates</p>
        {list.length === 0 ? (
          <p className="mt-10 text-sm text-muted-foreground">No templates match that search.</p>
        ) : (
          <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((t) => <li key={t.id}><LibraryCard t={t} /></li>)}
          </ul>
        )}
      </PageContainer>
    </>
  );
}

function LibraryCard({ t }: { t: LibraryTemplate }) {
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong focus-within:border-primary">
      <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-background">
        <img src={t.image} alt="" width={1024} height={640} loading="lazy" decoding="async" className="h-full w-full object-cover opacity-90 transition-transform duration-500 group-hover:scale-[1.03]" />
        <span className="absolute left-3 top-3 rounded border border-border bg-background/80 px-2 py-0.5 font-mono text-[11px] text-muted-foreground backdrop-blur">{t.category}</span>
        {t.planned && <span className="absolute right-3 top-3 rounded border border-border bg-background/80 px-2 py-0.5 font-mono text-[11px] text-subtle backdrop-blur">Planned</span>}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-semibold text-foreground">{t.name}</h3>
        <p className="mt-1 text-sm font-medium text-primary">{t.tagline}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.benefit}</p>
        <dl className="mt-5 grid grid-cols-3 gap-2 border-t border-border pt-4 text-center">
          <Capability label="Run" value={t.toolId ? <ExecutionState toolId={t.toolId} /> : "Not built"} />
          <Capability label="MCP" value={t.mcpAdapter ? "Adapter" : "No"} on={t.mcpAdapter} />
          <Capability label="Launch" value={t.tokenLaunch ? "Draft" : "No"} on={t.tokenLaunch} />
        </dl>
        <div className="mt-auto pt-5">
          {t.route && t.toolId ? <ToolAction t={t} toolId={t.toolId} route={t.route} /> : <span className="font-mono text-xs text-subtle">Not available yet — no tool to run</span>}
        </div>
      </div>
    </article>
  );
}

function Capability({ label, value, on }: { label: string; value: React.ReactNode; on?: boolean }) {
  return (
    <div>
      <dt className="label-mono text-[10px] text-subtle">{label}</dt>
      <dd className={cn("mt-1 font-mono text-xs", on ? "text-foreground" : "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

function useAvailable(toolId: string) {
  const q = STATUS[toolId as keyof typeof STATUS];
  const { data, isPending } = useQuery({ ...(q ?? STATUS.wallet_inspector), enabled: !!q });
  return { ready: !!q && !!data?.available, checking: !!q && isPending };
}

function ExecutionState({ toolId }: { toolId: string }) {
  const { ready, checking } = useAvailable(toolId);
  return <span className={ready ? "text-primary" : undefined}>{checking ? "Checking" : ready ? "Live" : "Offline"}</span>;
}

function ToolAction({ t, toolId, route }: { t: LibraryTemplate; toolId: string; route: string }) {
  const { ready, checking } = useAvailable(toolId);
  if (checking) return <span className="font-mono text-xs text-subtle">Checking execution service…</span>;
  if (!ready) return <span className="font-mono text-xs text-subtle">Execution service not connected</span>;
  return (
    <Link to={route as "/tools/token-scanner"} search={{}} className="inline-flex min-h-10 items-center rounded-md border border-border-strong px-4 text-sm text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      Open {t.name} <span aria-hidden className="ml-2">→</span>
    </Link>
  );
}
