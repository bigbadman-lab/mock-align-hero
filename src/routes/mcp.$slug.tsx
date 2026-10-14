import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { productProfileQuery } from "@/lib/product-profile.functions";
import type { Availability, PublicProfile } from "@/lib/product-profile";
import { EmptyState, PageContainer, PageHeader, RouteError, StatusMessage } from "@/components/mcpx/primitives";
import { CopyButton, CopyValue, McpConnection } from "@/components/mcpx/McpConnection";
import { TokenMarket } from "@/components/mcpx/TokenMarket";
import { ProductToolInterface, hasWebInterface } from "@/components/mcpx/product-run";
import { useState } from "react";

export const Route = createFileRoute("/mcp/$slug")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(productProfileQuery(params.slug)),
  head: ({ loaderData, params }) => {
    const p = loaderData?.status === "ok" ? loaderData.profile : null;
    const title = p ? `${p.displayName} ($${p.ticker}) — MCPX product` : "MCP product — MCPX";
    const description = p ? `${p.displayName}: a verified MCPX product built on the ${p.templateName} template.` : "MCPX product profile.";
    return {
      meta: [
        { title }, { name: "description", content: description },
        { property: "og:title", content: title }, { property: "og:description", content: description },
        { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
        ...(p ? [] : [{ name: "robots", content: "noindex" }]),
      ],
      links: [{ rel: "canonical", href: `https://mcpx.fun/mcp/${p?.slug ?? params.slug}` }],
    };
  },
  component: ProductPage,
  errorComponent: RouteError,
});

const LABEL: Record<Availability, string> = {
  active: "Verified · MCP endpoint active",
  inactive: "Verified · MCP endpoint not active",
  suspended: "Verified · suspended",
  not_configured: "Verified · tool not configured yet",
  misconfigured: "Verified · tool unavailable",
};

function ProductPage() {
  const { slug } = Route.useParams();
  const { data } = useSuspenseQuery(productProfileQuery(slug));
  if (data.status === "unavailable") {
    return (
      <PageContainer className="py-8">
        <StatusMessage tone="warning" title="Product registry unavailable">
          <p role="alert">We couldn't reach the product registry. This does not mean the product doesn't exist — try again later.</p>
        </StatusMessage>
      </PageContainer>
    );
  }
  if (data.status === "not_found") {
    return (
      <PageContainer className="py-8">
        <EmptyState title="No verified product at this address">
          <p>There is no verified MCPX product called “{slug}”. <Link to="/mcp" className="underline underline-offset-4">Browse templates</Link></p>
        </EmptyState>
      </PageContainer>
    );
  }
  return <Profile p={data.profile} />;
}

const solscan = (kind: "token" | "tx" | "account", v: string) => `https://solscan.io/${kind}/${v}`;

function Fact({ k, v, href, copy }: { k: string; v: string; href?: string; copy?: boolean }) {
  return (
    <div className="grid gap-0.5 border-b border-border py-1.5 last:border-0 sm:grid-cols-[10rem_1fr]">
      <dt className="label-mono text-subtle">{k}</dt>
      <dd className="break-all font-mono text-sm text-foreground">
        {copy ? <CopyValue text={v} /> : href ? <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">{v}</a> : v}
      </dd>
    </div>
  );
}

type Tab = "use" | "mcp" | "details";

function Profile({ p }: { p: PublicProfile }) {
  const url = `https://mcpx.fun/mcp/${p.slug}`;
  const interactive = hasWebInterface(p.templateId) && p.availability === "active" && !!p.tool;
  const tabs: { id: Tab; label: string }[] = [
    ...(interactive ? [{ id: "use" as const, label: "Use Tool" }] : []),
    { id: "mcp", label: "Connect via MCP" },
    { id: "details", label: "Token Details" },
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]!.id);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(n.id);
    document.getElementById(`tab-${n.id}`)?.focus();
  };
  return (
    <>
      <PageHeader
        className="py-6 sm:py-8"
        label={LABEL[p.availability]}
        title={<>{p.displayName} <span className="font-mono text-subtle">${p.ticker}</span></>}
        intro={<>
          {p.description && <span className="block">{p.description}</span>}
          <span className="mt-2 flex flex-wrap gap-2">
            <span className="label-mono rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">{p.templateName} · v{p.templateVersion}</span>
            {p.rehearsal && <span className="label-mono rounded border border-warning/50 px-2 py-0.5 text-xs text-warning">SOL rehearsal · not $MCP-paired</span>}
          </span>
        </>}
      />
      <PageContainer className="space-y-4 py-6">
        <div role="tablist" aria-label="Product sections" className="flex gap-1 overflow-x-auto border-b border-border">
          {tabs.map((t, i) => (
            <button
              key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} onKeyDown={(e) => onKey(e, i)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >{t.label}</button>
          ))}
        </div>

        {tab === "use" && interactive && (
          <div role="tabpanel" id="panel-use" aria-labelledby="tab-use" className="rounded-lg border border-border bg-card p-4">
            <ProductToolInterface p={p} />
          </div>
        )}

        {tab === "mcp" && (
          <div role="tabpanel" id="panel-mcp" aria-labelledby="tab-mcp">
            {p.endpoint && p.tool ? (
              <McpConnection endpoint={p.endpoint} tool={p.tool} />
            ) : (
              <StatusMessage tone="warning" title="MCP endpoint not available">
                <p>{p.availability === "suspended" ? "This product is suspended. Its MCP endpoint does not accept requests." : "This product's MCP endpoint is not active, so there is nothing to connect to yet."}</p>
              </StatusMessage>
            )}
          </div>
        )}

        {tab === "details" && (
          <div role="tabpanel" id="panel-details" aria-labelledby="tab-details" className="space-y-4">
            <section aria-labelledby="facts-h" className="rounded-lg border border-border bg-card p-4">
              <h2 id="facts-h" className="mb-2 text-base font-semibold">Verified facts</h2>
              <dl>
                <Fact k="Name" v={`${p.displayName} ($${p.ticker})`} />
                <Fact k="Template" v={`${p.templateName} · v${p.templateVersion}${p.engine ? ` · ${p.engine}` : ""}`} />
                <Fact k="Creator wallet" v={p.creatorWallet} href={solscan("account", p.creatorWallet)} />
                <Fact k="Token mint" v={p.childMint} copy />
                <Fact k="Quote asset" v={p.rehearsal ? `SOL (rehearsal) · ${p.quoteMint}` : p.quoteMint} href={solscan("token", p.quoteMint)} />
                {p.rehearsal && <Fact k="Pairing" v="SOL rehearsal — a one-time test launch before $MCP exists; excluded from $MCP rewards and Treasury." />}
                <Fact k="Creation transaction" v={p.verifiedTx} href={solscan("tx", p.verifiedTx)} />
                <Fact k="Verified" v={`${new Date(p.verifiedAt).toISOString().slice(0, 16).replace("T", " ")} UTC · slot ${p.verifiedSlot} · ${p.network}`} />
                <Fact k="Product ID" v={p.creationId} />
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Share: <span className="font-mono">{url}</span></span>
                <CopyButton text={url} label="Copy link" />
              </div>
            </section>
            <TokenMarket slug={p.slug} />
          </div>
        )}
      </PageContainer>
    </>
  );
}
