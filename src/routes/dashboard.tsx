import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer, PageHeader, StatusMessage, EmptyState, FeatureAvailability, RouteError, buttonOutline } from "@/components/mcpx/primitives";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — MCPX" },
      { name: "description", content: "Your future MCPX account: tools, fee records and rewards history." },
      { property: "og:title", content: "Dashboard — MCPX" },
      { property: "og:description", content: "Account foundation. Wallet connection is not available in this phase." },
    ],
  }),
  component: Dashboard,
  errorComponent: RouteError,
});

const SECTIONS = [
  { id: "tools", title: "Your tools", body: "Tools you create will be listed here." },
  { id: "fees", title: "Fee records", body: "Creator fees actually collected for your tools will be recorded here." },
  { id: "rewards", title: "Rewards history", body: "Any genuine $MCP holder rewards you receive will appear here." },
];

function Dashboard() {
  return (
    <>
      <PageHeader label="Account" title="Dashboard" intro="Your tools, fee records and rewards history will live here." />
      <PageContainer className="space-y-8 py-16">
        <StatusMessage tone="warning" title="Wallet connection is not available in this phase.">
          There is no account to show yet. Nothing on this page reflects real wallet data.
        </StatusMessage>
        <div className="grid gap-4 lg:grid-cols-3">
          {SECTIONS.map((s) => (
            <section key={s.id} aria-labelledby={`d-${s.id}`} className="rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                <h2 id={`d-${s.id}`} className="text-sm font-semibold">{s.title}</h2>
                <FeatureAvailability>Later phase</FeatureAvailability>
              </div>
              <EmptyState title="Nothing here yet">{s.body}</EmptyState>
            </section>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/mcp" className={buttonOutline}>Browse templates</Link>
          <Link to="/docs" className={buttonOutline}>Read the docs</Link>
        </div>
      </PageContainer>
    </>
  );
}
