import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { walletInspectorStatusQuery } from "@/lib/tools/status";
import { PageContainer, PageHeader, TemplateCard, RouteError } from "@/components/mcpx/primitives";
import { ENGINES, TEMPLATES } from "@/lib/templates";

export const Route = createFileRoute("/mcp")({
  head: () => ({
    meta: [
      { title: "MCP Templates — MCPX" },
      { name: "description", content: "Six planned MCPX tool templates across Wallet, Token and Verify engines." },
      { property: "og:title", content: "MCP Templates — MCPX" },
      { property: "og:description", content: "Six planned Solana tool templates. Execution arrives in Phase 02." },
    ],
  }),
  component: McpPage,
  errorComponent: RouteError,
});

function McpPage() {
  return (
    <>
      <PageHeader label="Template directory" title="Six MCP templates" intro="Product definitions describing what each tool is intended to do. None can be run yet." />
      <PageContainer className="space-y-16 py-16">
        {ENGINES.map((e) => (
          <section key={e.id} aria-labelledby={`eng-${e.id}`}>
            <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border pb-4">
              <h2 id={`eng-${e.id}`} className="label-mono text-sm text-primary">{e.id}</h2>
              <p className="text-sm text-muted-foreground">{e.blurb}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {TEMPLATES.filter((t) => t.engine === e.id).map((t) => <TemplateCard key={t.id} t={t} action={t.id === "wallet-inspector" ? <WalletInspectorAction /> : undefined} />)}
            </div>
          </section>
        ))}
      </PageContainer>
    </>
  );
}

// Shows "Inspect wallet" only when the live execution service reports ready; otherwise the honest preview note.
function WalletInspectorAction() {
  const { data } = useQuery(walletInspectorStatusQuery);
  if (!data?.available) return <span className="font-mono text-xs text-subtle">Execution service not connected yet</span>;
  return <Link to="/tools/wallet-inspector" className="label-mono text-xs text-primary underline underline-offset-4">Inspect wallet · live</Link>;
}
