import { createFileRoute, Link } from "@tanstack/react-router";
import { WalletPanel } from "@/components/mcpx/wallet/WalletControls";
import { CreatorSignIn } from "@/components/mcpx/CreatorSignIn";
import { CanvasWorkspace } from "@/components/mcpx/dashboard/CanvasWorkspace";
import { PageContainer, PageHeader, FeatureAvailability, RouteError, buttonOutline } from "@/components/mcpx/primitives";
import { useCreatorSession } from "@/lib/creator-auth/use-creator-session";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — MCPX" },
      { name: "description", content: "Sign in with your Solana wallet to open your MCPX dashboard. Tools, fees and rewards appear once they exist." },
      { property: "og:title", content: "Dashboard — MCPX" },
      { property: "og:description", content: "Sign in with your Solana wallet to open your MCPX dashboard." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
  errorComponent: RouteError,
});

// Not-yet-built areas. Shown as unavailable — never as verified zero balances.
const UNAVAILABLE = [
  { id: "earnings", title: "Creator earnings", reason: "Not available — the fee ledger is not built yet." },
  { id: "rewards", title: "Native rewards", reason: "Not available — $MCP has not been minted." },
  { id: "activity", title: "Tool activity", reason: "Not available — product activity appears only after a verified token launch." },
];

export function Dashboard() {
  const session = useCreatorSession();
  const signedIn = session.s === "signed_in";

  // CreatorSignIn owns the sign-in flow; it tells us when the answer flips so the gated
  // areas open or close without polling.
  const onSessionChange = (signed: boolean) => {
    if (signed !== (session.s === "signed_in")) session.refresh();
  };

  return (
    <>
      <PageHeader
        label="Account"
        title="Dashboard"
        intro={signedIn
          ? "Your signed-in wallet. Creations, earnings, rewards and tool activity will appear here once they exist."
          : "Sign in with your wallet to open your dashboard."}
      />
      <PageContainer className="space-y-8 py-16">
        <WalletPanel />
        <CreatorSignIn onSessionChange={onSessionChange} />

        {signedIn ? (
          <>
            <CanvasWorkspace />
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
          </>
        ) : (
          <section aria-labelledby="d-locked" className="rounded-lg border border-border bg-card p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="d-locked" className="text-sm font-semibold">Your dashboard areas</h2>
              <FeatureAvailability>Sign-in required</FeatureAvailability>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              These open once you're signed in with your wallet. Some are still being built and will show their status plainly when they do.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li>Canvas workspace — edit the pipeline of your launched Canvas products</li>
              <li>Verified MCP creations — products linked to your wallet</li>
              <li>Creator earnings, native rewards and tool activity</li>
            </ul>
          </section>
        )}

        <div className="flex flex-wrap gap-3">
          <Link to="/mcp" className={buttonOutline}>Browse templates</Link>
          <Link to="/docs" className={buttonOutline}>Read the docs</Link>
        </div>
      </PageContainer>
    </>
  );
}
