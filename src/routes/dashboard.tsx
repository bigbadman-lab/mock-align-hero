import { createFileRoute, Link } from "@tanstack/react-router";
import { WalletPanel } from "@/components/mcpx/wallet/WalletControls";
import { PageContainer, PageHeader, FeatureAvailability, RouteError, buttonOutline } from "@/components/mcpx/primitives";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — MCPX" },
      { name: "description", content: "Connect a Solana wallet to see your public address. Creations, earnings, rewards and tool activity arrive later." },
      { property: "og:title", content: "Dashboard — MCPX" },
      { property: "og:description", content: "Connect a Solana wallet to see your public address. Tools, fees and rewards arrive later." },
    ],
  }),
  component: Dashboard,
  errorComponent: RouteError,
});

// Not-yet-built areas. Shown as unavailable — never as verified zero balances.
const UNAVAILABLE = [
  { id: "earnings", title: "Creator earnings", reason: "Not available — the fee ledger is not built yet." },
  { id: "rewards", title: "Native rewards", reason: "Not available — $MCP has not been minted." },
  { id: "activity", title: "Tool activity", reason: "Not available — tool execution is not built yet." },
];

function Dashboard() {
  return (
    <>
      <PageHeader label="Account" title="Dashboard" intro="Your connected wallet today. Creations, earnings, rewards and tool activity will appear here once they exist." />
      <PageContainer className="space-y-8 py-16">
        <WalletPanel />
        <section aria-labelledby="d-creations" className="rounded-lg border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="d-creations" className="text-sm font-semibold">Verified MCP creations</h2>
            <FeatureAvailability>Public registry only</FeatureAvailability>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Creations linked to your wallet are not shown here yet. All verified creations are listed publicly on the Paired page.
          </p>
          <Link to="/paired" className={`${buttonOutline} mt-4`}>Open the verified registry</Link>
        </section>
        <section aria-labelledby="d-later" className="rounded-lg border border-border bg-card">
          <h2 id="d-later" className="border-b border-border px-6 py-4 text-sm font-semibold">Coming in later phases</h2>
          <ul>
            {UNAVAILABLE.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4 last:border-0">
                <div>
                  <p className="text-sm text-foreground">{s.title}</p>
                  <p className="text-sm text-muted-foreground">{s.reason}</p>
                </div>
                <FeatureAvailability>Later phase</FeatureAvailability>
              </li>
            ))}
          </ul>
        </section>
        <div className="flex flex-wrap gap-3">
          <Link to="/mcp" className={buttonOutline}>Browse templates</Link>
          <Link to="/docs" className={buttonOutline}>Read the docs</Link>
        </div>
      </PageContainer>
    </>
  );
}
