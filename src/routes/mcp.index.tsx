import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CapabilityRow, TemplateAction } from "@/components/mcpx/TemplateAvailability";
import { PageContainer, PageHeader, RouteError } from "@/components/mcpx/primitives";
import { LIBRARY, LIBRARY_CATEGORIES, type LibraryCategory, type LibraryTemplate } from "@/lib/templates";
import { cn } from "@/lib/utils";

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
    return LIBRARY.filter((t) => !t.hidden && (cat === "All" || t.category === cat) && (!s || `${t.name} ${t.tagline} ${t.benefit} ${t.category}`.toLowerCase().includes(s)));
  }, [q, cat]);

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Tool library" title="Explore the MCP Tool Library" intro="Discover powerful Solana tools built for real onchain utility. Explore live capabilities, connect through MCP and turn supported tools into token-powered products." />
      <PageContainer className="py-6">
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
        <p className="mt-4 font-mono text-xs text-subtle" aria-live="polite">{list.length} of {LIBRARY.filter((t) => !t.hidden).length} templates</p>
        {list.length === 0 ? (
          <p className="mt-10 text-sm text-muted-foreground">No templates match that search.</p>
        ) : (
          <ul className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
      <div className="flex flex-1 flex-col p-3">
        <h3 className="text-lg font-semibold text-foreground">{t.name}</h3>
        <p className="mt-1 text-sm font-medium text-primary">{t.tagline}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.benefit}</p>
        <div className="mt-5 border-t border-border pt-4"><CapabilityRow t={t} /></div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5">
          <TemplateAction t={t} />
          <Link to="/templates/$templateId" params={{ templateId: t.id }} className="text-sm text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-primary">
            Details<span className="sr-only"> for {t.name}</span>
          </Link>
        </div>
      </div>
    </article>
  );
}

