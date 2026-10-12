import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { accountCheckerStatusQuery, whaleWatchStatusQuery, supplyMonitorStatusQuery, tokenScannerStatusQuery, transactionVerifierStatusQuery, walletInspectorStatusQuery } from "@/lib/tools/status";
import { PageContainer, PageHeader, TemplateCard, RouteError } from "@/components/mcpx/primitives";
import { ENGINES, TEMPLATES } from "@/lib/templates";

export const Route = createFileRoute("/mcp")({
  head: () => ({
    meta: [
      { title: "MCP Templates — MCPX" },
      { name: "description", content: "Six planned MCPX tool templates across Wallet, Token and Verify engines." },
      { property: "og:title", content: "MCP Templates — MCPX" },
      { property: "og:description", content: "Six read-only Solana tool templates; each shows a live link only when its execution service is ready." },
    ],
  }),
  component: McpPage,
  errorComponent: RouteError,
});

function McpPage() {
  return (
    <>
      <PageHeader label="Template directory" title="Six MCP templates" intro="Product definitions describing what each tool is intended to do. A tool shows a live link only when its execution service reports ready." />
      <PageContainer className="space-y-16 py-16">
        {ENGINES.map((e) => (
          <section key={e.id} aria-labelledby={`eng-${e.id}`}>
            <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border pb-4">
              <h2 id={`eng-${e.id}`} className="label-mono text-sm text-primary">{e.id}</h2>
              <p className="text-sm text-muted-foreground">{e.blurb}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {TEMPLATES.filter((t) => t.engine === e.id).map((t) => <TemplateCard key={t.id} t={t} action={t.id === "wallet-inspector" ? <WalletInspectorAction /> : t.id === "tx-verifier" ? <TxVerifierAction /> : t.id === "token-scanner" ? <TokenScannerAction /> : t.id === "supply-monitor" ? <SupplyMonitorAction /> : t.id === "whale-watch" ? <WhaleWatchAction /> : t.id === "account-checker" ? <AccountCheckerAction /> : undefined} />)}
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

function TxVerifierAction() {
  const { data } = useQuery(transactionVerifierStatusQuery);
  if (!data?.available) return <span className="font-mono text-xs text-subtle">Execution service not connected yet</span>;
  return <Link to="/tools/transaction-verifier" className="label-mono text-xs text-primary underline underline-offset-4">Verify transaction · live</Link>;
}

function TokenScannerAction() {
  const { data } = useQuery(tokenScannerStatusQuery);
  if (!data?.available) return <span className="font-mono text-xs text-subtle">Execution service not connected yet</span>;
  return <Link to="/tools/token-scanner" search={{}} className="label-mono text-xs text-primary underline underline-offset-4">Scan token · live</Link>;
}

function SupplyMonitorAction() {
  const { data } = useQuery(supplyMonitorStatusQuery);
  if (!data?.available) return <span className="font-mono text-xs text-subtle">Execution service not connected yet</span>;
  return <Link to="/tools/supply-monitor" className="label-mono text-xs text-primary underline underline-offset-4">Check supply · live</Link>;
}

function WhaleWatchAction() {
  const { data } = useQuery(whaleWatchStatusQuery);
  if (!data?.available) return <span className="font-mono text-xs text-subtle">Not deployed yet</span>;
  return <Link to="/tools/whale-watch" className="label-mono text-xs text-primary underline underline-offset-4">Whale Watch · live</Link>;
}

function AccountCheckerAction() {
  const { data } = useQuery(accountCheckerStatusQuery);
  if (!data?.available) return <span className="font-mono text-xs text-subtle">Not deployed yet</span>;
  return <Link to="/tools/account-checker" className="label-mono text-xs text-primary underline underline-offset-4">Check account · live</Link>;
}
