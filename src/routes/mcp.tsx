import { createFileRoute } from "@tanstack/react-router";
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
              {TEMPLATES.filter((t) => t.engine === e.id).map((t) => <TemplateCard key={t.id} t={t} />)}
            </div>
          </section>
        ))}
      </PageContainer>
    </>
  );
}
