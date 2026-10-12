import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer, PageHeader, StatusMessage, SectionHeading, RouteError, buttonOutline } from "@/components/mcpx/primitives";

export const Route = createFileRoute("/launch")({
  head: () => ({
    meta: [
      { title: "Launch — MCPX" },
      { name: "description", content: "How the planned MCPX one-page token and tool builder is intended to work." },
      { property: "og:title", content: "Launch — MCPX" },
      { property: "og:description", content: "Token launching is not yet available. Here is what the builder will ask for." },
    ],
  }),
  component: Launch,
  errorComponent: RouteError,
});

const INPUTS = [
  ["Template", "One of the six tool templates."],
  ["Name", "The display name of your token and tool."],
  ["Ticker", "A short symbol for the child token."],
  ["Square artwork", "An image used for the token and profile."],
  ["Mission", "A short description of what the tool is for."],
  ["Tool presets", "A few defaults, such as how many transactions to show."],
  ["Display style", "How results look on the tool's profile page."],
  ["Initial buy (optional)", "A developer buy denominated in $MCP. Defaults to none."],
];

function Launch() {
  return (
    <>
      <PageHeader label="Builder" title="Launch a tool token" intro="A one-page builder for creating a child token and its tool together." />
      <PageContainer className="space-y-12 py-16">
        <StatusMessage tone="warning" title="Token launching is not yet available.">
          A real launch requires a verified native $MCP token and a completed onchain implementation. Neither exists yet.
        </StatusMessage>
        <section aria-labelledby="inputs">
          <SectionHeading label="Planned inputs" title={<span id="inputs">What the builder will ask for</span>} />
          <dl className="mt-8 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
            {INPUTS.map(([k, v]) => (
              <div key={k} className="bg-card p-5">
                <dt className="font-mono text-sm text-foreground">{k}</dt>
                <dd className="mt-1 text-sm text-muted-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="flex flex-wrap gap-3">
          <Link to="/mcp" className={buttonOutline}>Browse templates</Link>
          <Link to="/docs" hash="launch-flow" className={buttonOutline}>Read about the launch flow</Link>
        </div>
      </PageContainer>
    </>
  );
}
