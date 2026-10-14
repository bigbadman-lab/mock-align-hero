import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer, SectionHeading, SectionLabel, InfoCard, StatusMessage, RouteError, buttonPrimary, buttonOutline } from "@/components/mcpx/primitives";
import { TEMPLATES, ENGINES } from "@/lib/templates";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MCPX — Every token powers a tool" },
      { name: "description", content: "MCPX is being built as a platform for real Solana-connected MCP tools paired to native $MCP." },
      { property: "og:title", content: "MCPX — Every token powers a tool" },
      { property: "og:description", content: "A platform in development for Solana-connected MCP tools paired to native $MCP." },
    ],
  }),
  component: Home,
  errorComponent: RouteError,
});

const FLOW = [
  { n: "01", t: "Choose Tool", d: "Pick one of six template definitions." },
  { n: "02", t: "Configure", d: "Set name, presets and display style." },
  { n: "03", t: "Create Token", d: "A child token paired to $MCP." },
  { n: "04", t: "Use Tool", d: "On site and via MCP-compatible clients." },
];

function Home() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border bg-grid">
        <PageContainer className="py-20 sm:py-28 lg:py-32">
          <div className="max-w-3xl animate-rise">
            <SectionLabel>Solana · MCP · $MCP</SectionLabel>
            <h1 className="mt-6 font-mono text-6xl font-semibold tracking-tight text-foreground sm:text-7xl lg:text-8xl">MCPX</h1>
            <p className="mt-4 text-2xl font-medium text-foreground sm:text-3xl">
              Every token powers a <span className="text-primary">tool</span>.
            </p>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              MCPX is being built as a platform for creating real Solana-connected MCP tools, each associated with a token paired to native $MCP.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link to="/mcp" className={buttonPrimary}>Explore MCP templates</Link>
              <Link to="/docs" className={buttonOutline}>Read the docs</Link>
            </div>
          </div>
        </PageContainer>
      </section>

      <section aria-labelledby="flow" className="border-b border-border">
        <PageContainer className="py-20">
          <SectionHeading label="Planned product flow" title={<span id="flow">From template to working tool</span>} intro="This is the intended journey. None of these steps can be performed yet." />
          <ol className="mt-10 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {FLOW.map((s) => (
              <li key={s.n} className="bg-background p-6">
                <span className="font-mono text-xs text-primary">{s.n}</span>
                <p className="mt-3 font-semibold text-foreground">{s.t}</p>
                <p className="mt-1 text-sm text-muted-foreground">{s.d}</p>
              </li>
            ))}
          </ol>
        </PageContainer>
      </section>

      <section aria-labelledby="tpl" className="border-b border-border">
        <PageContainer className="py-20">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHeading label="Tool library" title={<span id="tpl">Ten live tools, plus Canvas</span>} intro="Read-only Solana tools you can run today, and Canvas to chain 2–4 of them into one pipeline." />
            <Link to="/mcp" className={buttonOutline}>View all templates</Link>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {ENGINES.map((e) => (
              <div key={e.id} className="rounded-lg border border-border bg-card p-6">
                <p className="label-mono text-primary">{e.id}</p>
                <p className="mt-2 text-sm text-muted-foreground">{e.blurb}</p>
                <ul className="mt-4 space-y-1">
                  {TEMPLATES.filter((t) => t.engine === e.id).map((t) => (
                    <li key={t.id} className="font-mono text-sm text-foreground">{t.name}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </PageContainer>
      </section>

      <section aria-labelledby="vision" className="border-b border-border">
        <PageContainer className="py-20">
          <SectionHeading label="Planned capability" title={<span id="vision">Useful in two places</span>} />
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <InfoCard label="On site" title="Run tools in the browser">Each created tool is intended to have a permanent profile page where anyone can use it.</InfoCard>
            <InfoCard label="Via MCP" title="Use tools from AI clients">Each tool is intended to get its own MCP endpoint for MCP-compatible clients. Not available yet.</InfoCard>
          </div>
        </PageContainer>
      </section>

      <section aria-labelledby="status">
        <PageContainer className="py-20">
          <SectionHeading label="Current status" title={<span id="status">What exists today</span>} />
          <div className="mt-8 grid gap-3 md:grid-cols-2">
            <StatusMessage title="Available now">Template definitions, documentation, Solana wallet connection (public address only) and the read-only verified registry.</StatusMessage>
            <StatusMessage tone="warning" title="Not available yet">Onchain token creation, earnings and rewards. Template tools run read-only, one at a time, when their service is ready. $MCP has not been minted.</StatusMessage>
          </div>
        </PageContainer>
      </section>
    </>
  );
}
