import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer, PageHeader, EmptyState, RouteError } from "@/components/mcpx/primitives";

export const Route = createFileRoute("/paired")({
  head: () => ({
    meta: [
      { title: "Paired Market — MCPX" },
      { name: "description", content: "Directory of verified MCPX child tokens paired to $MCP. No listings yet." },
      { property: "og:title", content: "Paired Market — MCPX" },
      { property: "og:description", content: "Verified child-token listings will appear here after genuine launches." },
    ],
  }),
  component: Paired,
  errorComponent: RouteError,
});

const COLS = ["Token", "Tool template", "Paired to", "Launched"];

function Paired() {
  return (
    <>
      <PageHeader label="Paired market" title="Paired tokens" intro="Child tokens paired to $MCP, each powering one tool." />
      <PageContainer className="py-16">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div role="presentation" className="hidden grid-cols-4 gap-4 border-b border-border bg-surface-2 px-5 py-3 sm:grid">
            {COLS.map((c) => <span key={c} className="label-mono text-subtle">{c}</span>)}
          </div>
          <EmptyState title="No verified MCPX child-token listings are available.">
            <p>$MCP has not been minted yet. Listings will appear only after genuine, verified launches.</p>
            <p className="mt-4">
              <Link to="/docs" hash="tokens" className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary">How token pairing is intended to work</Link>
            </p>
          </EmptyState>
        </div>
      </PageContainer>
    </>
  );
}
