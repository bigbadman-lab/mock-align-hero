import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageContainer, PageHeader, FeatureAvailability, RouteError } from "@/components/mcpx/primitives";
import { TEMPLATES } from "@/lib/templates";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — MCPX" },
      { name: "description", content: "Accurate documentation of the planned MCPX product and its current phase." },
      { property: "og:title", content: "Docs — MCPX" },
      { property: "og:description", content: "What MCPX is, how templates, launches, fees and rewards are intended to work." },
    ],
  }),
  component: Docs,
  errorComponent: RouteError,
});

const TOC = [
  ["what", "What is MCPX?"],
  ["templates", "Templates & execution"],
  ["launch-flow", "Launch flow"],
  ["tokens", "Token relationships"],
  ["fees", "Creator fee split"],
  ["rewards", "$MCP rewards concept"],
  ["endpoints", "MCP endpoint model"],
  ["status", "Current availability"],
] as const;

function Doc({ id, title, planned, children }: { id: string; title: string; planned?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 border-b border-border pb-12">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={`${id}-h`} className="text-2xl font-semibold tracking-tight">{title}</h2>
        {planned && <FeatureAvailability>Design intent · not live</FeatureAvailability>}
      </div>
      <div className="mt-4 space-y-4 text-base leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function Docs() {
  return (
    <>
      <PageHeader label="Documentation" title="MCPX docs" intro="Sections marked “design intent” describe planned behaviour, not functionality you can use today." />
      <PageContainer className="grid gap-12 py-16 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Docs sections" className="lg:sticky lg:top-24 lg:self-start">
          <p className="label-mono mb-3 text-subtle">On this page</p>
          <ul className="grid grid-cols-2 gap-x-4 sm:grid-cols-4 lg:grid-cols-1">
            {TOC.map(([id, t]) => (
              <li key={id}><a href={`#${id}`} className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground">{t}</a></li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 max-w-3xl space-y-12">
          <Doc id="what" title="What is MCPX?">
            <p>MCPX is being built as a platform where each token powers a real tool. A creator picks a template, configures it and launches a child token paired to native $MCP. The tool then reads Solana data for anyone who uses it.</p>
          </Doc>
          <Doc id="templates" title="Templates and on-demand execution" planned>
            <p>Six templates are defined across three engines. Every tool is planned to run on demand, when someone asks. There is no continuous monitoring or autonomous alerting.</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {TEMPLATES.map((t) => (
                <li key={t.id} className="p-4">
                  <p className="text-foreground"><span className="label-mono mr-2 text-primary">{t.engine}</span>{t.name}</p>
                  <p className="mt-1 text-sm">{t.purpose} {t.details.join(" ")}</p>
                </li>
              ))}
            </ul>
          </Doc>
          <Doc id="launch-flow" title="How the launch flow is intended to work" planned>
            <p>The builder collects a template, name, ticker, artwork, mission, presets, display style and an optional initial buy in $MCP. One successful launch is meant to produce one verifiable token, one tool configuration, one MCP endpoint and one permanent profile.</p>
          </Doc>
          <Doc id="tokens" title="Token relationships" planned>
            <p>$MCP is the native MCPX token. Each tool's child token is intended to be quoted in $MCP rather than SOL, through a custom pairing. $MCP has not been minted, and no contract address exists.</p>
          </Doc>
          <Doc id="fees" title="Planned creator fee split" planned>
            <p>Each child token's eligible, actually collected creator fees are planned to be split:</p>
            <ul className="grid gap-2 sm:grid-cols-3">
              {[["60%", "Creator"], ["25%", "Tool operations"], ["15%", "Platform"]].map(([p, l]) => (
                <li key={l} className="rounded-md border border-border bg-card p-4"><span className="font-mono text-xl text-foreground">{p}</span><span className="block text-sm">{l}</span></li>
              ))}
            </ul>
            <p>These are shares of fees actually collected, not a fee rate or a share of trading volume. The split is subject to final onchain verification before any launch.</p>
          </Doc>
          <Doc id="rewards" title="Native $MCP rewards concept" planned>
            <p>Of the creator fees actually collected on $MCP itself, 60% is planned for holders and 40% for the protocol. The holder portion would be split equally between SOL payouts and $MCP bought with SOL.</p>
            <p>This is not live. There is no APY and no guaranteed return.</p>
          </Doc>
          <Doc id="endpoints" title="MCP endpoint model" planned>
            <p>Each created tool is planned to have its own endpoint in this form:</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-4 font-mono text-sm text-foreground">https://mcp.mcpx.fun/{"{creation-id}"}/mcp</pre>
            <p>This endpoint is planned and not available. Nothing responds at this address today.</p>
          </Doc>
          <Doc id="status" title="Current availability">
            <p><span className="text-foreground">Available now:</span> this website, the six template definitions, this documentation, Solana wallet connection (shows your public address only — not a sign-in, nothing is signed), and a read-only registry of verified creations shown on the Paired page.</p>
            <p><span className="text-foreground">Not available:</span> token launching, tool execution, MCP endpoints, market listings, creator earnings and $MCP rewards.</p>
          </Doc>
        </div>
      </PageContainer>
    </>
  );
}
