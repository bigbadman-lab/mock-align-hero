import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageContainer, PageHeader, FeatureAvailability, RouteError } from "@/components/mcpx/primitives";
import { CopyButton } from "@/components/mcpx/McpConnection";
import { LIBRARY } from "@/lib/templates";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — MCPX" },
      { name: "description", content: "How MCPX works today: the tool library, Canvas, creator sign-in, MCP endpoints, launches, fees and $MCP rewards." },
      { property: "og:title", content: "Docs — MCPX" },
      { property: "og:description", content: "What is live on MCPX today, and how launches, fee splits and $MCP holder rewards are designed to work." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Docs,
  errorComponent: RouteError,
});

const TOC = [
  ["what", "What is MCPX?"],
  ["tools", "Tool library"],
  ["canvas", "Canvas"],
  ["signin", "Creator sign-in"],
  ["endpoints", "MCP endpoints"],
  ["launch-flow", "Launch flow"],
  ["fees", "Child token fees"],
  ["addresses", "Protocol addresses"],
  ["rewards", "$MCP holder rewards"],
  ["status", "Current availability"],
] as const;

function Doc({ id, title, planned, children }: { id: string; title: string; planned?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 border-b border-border pb-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-h`} className="text-xl font-semibold tracking-tight">{title}</h2>
        {planned && <FeatureAvailability>Not live yet</FeatureAvailability>}
      </div>
      <div className="mt-2 space-y-3 text-base leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-sm text-foreground">{children}</pre>
);

function Docs() {
  const tools = LIBRARY.filter((t) => t.id !== "canvas" && !t.hidden);
  return (
    <>
      <PageHeader label="Documentation" title="MCPX docs" intro="What you can use today, and how the parts marked “Not live yet” are designed to work." />
      <PageContainer className="grid gap-6 py-8 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Docs sections" className="lg:sticky lg:top-24 lg:self-start">
          <p className="label-mono mb-2 text-subtle">On this page</p>
          <ul className="grid grid-cols-2 gap-x-4 sm:grid-cols-4 lg:grid-cols-1">
            {TOC.map(([id, t]) => (
              <li key={id}><a href={`#${id}`} className="inline-flex min-h-8 items-center text-sm text-muted-foreground hover:text-foreground">{t}</a></li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 max-w-3xl space-y-6">
          <Doc id="what" title="What is MCPX?">
            <p>MCPX is a platform for MCP tools on Solana. Anyone can run the tools on this site today. Creators will be able to launch a child token paired to $MCP, the native MCPX token, and each child token comes with its own working MCP tool that AI assistants can connect to.</p>
          </Doc>

          <Doc id="tools" title="Tool library">
            <p>Ten read-only tools run on real Solana data. Each runs only when you ask: there is no background monitoring or alerting, and no tool can sign or send anything. Each visitor gets 3 free tests per tool per day.</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {tools.map((t) => (
                <li key={t.id} className="p-3">
                  <p className="text-foreground"><span className="label-mono mr-2 text-primary">{t.category}</span>{t.route ? <a href={t.route} className="hover:underline">{t.name}</a> : t.name}</p>
                  <p className="mt-1 text-sm">{t.benefit}</p>
                </li>
              ))}
            </ul>
          </Doc>

          <Doc id="canvas" title="Canvas">
            <p>Canvas is Template 11. It chains 2–4 compatible tools into one fixed-order pipeline, passing an address from one step to the next only through approved connections. No custom code or outside web addresses are allowed.</p>
            <p>Signed-in creators can configure Canvas inside the launch form, save and reopen drafts, and run test runs on the real tools. Canvas is not a standalone product: it becomes a public MCP tool only after its child token launch is verified onchain. An optional AI summary step can use the creator's own OpenAI key.</p>
          </Doc>

          <Doc id="signin" title="Creator sign-in">
            <p>Connecting a wallet only shows your public address. To use creator features, you sign in on the Dashboard by signing a readable message with your wallet. This is a message, not a transaction: it costs nothing and moves no funds. The session lasts up to 24 hours.</p>
            <p>Only the wallet recorded as a product's verified onchain creator can manage that product.</p>
          </Doc>

          <Doc id="endpoints" title="MCP endpoints">
            <p><span className="text-foreground">Platform test endpoint (invite-only):</span> a working MCP server that proves external AI clients can call MCPX tools. It needs a private access key issued by the MCPX team and shares the website's rate limits.</p>
            <Code>{`https://mcpx.fun/api/public/mcp/platform-demo
Authorization: Bearer <key issued by MCPX>`}</Code>
            <p><span className="text-foreground">Product endpoints:</span> each launched product gets its own endpoint, shown on its product page only once the product is active.</p>
            <Code>{"https://mcpx.fun/api/public/mcp/products/{product-id}"}</Code>
            <p>Each product uses its own secret key, added once in your MCP client's settings as an <code className="font-mono">Authorization: Bearer</code> header. A key works only for its own product, can be revoked or replaced, and is shown once only; a lost key can be replaced but not recovered. No products have launched yet, so no product endpoint is accepting connections today.</p>
          </Doc>

          <Doc id="launch-flow" title="Launch flow" planned>
            <p>The launch form collects a template, name, ticker, artwork, description, settings and an optional first buy by the creator, entered in $MCP. Signed-in creators can fill it in and save drafts today. One successful launch creates one child token, one tool configuration, one MCP endpoint and one permanent product page. A draft is only marked as launched after the token creation is verified onchain.</p>
            <p>Traders buy child tokens with SOL; each child token is paired to $MCP.</p>
          </Doc>

          <Doc id="fees" title="Child token fee split" planned>
            <p>Creator fees actually collected on each child token are split:</p>
            <ul className="grid gap-2 sm:grid-cols-3">
              {[["60%", "Creator"], ["25%", "Tool operations"], ["15%", "MCPX platform"]].map(([p, l]) => (
                <li key={l} className="rounded-md border border-border bg-card p-3"><span className="font-mono text-lg text-foreground">{p}</span><span className="block text-sm">{l}</span></li>
              ))}
            </ul>
            <p>These are shares of fees actually collected, not a fee rate or a share of trading volume. The split is locked onchain at launch.</p>
          </Doc>

          <Doc id="addresses" title="Protocol addresses">
            <p>These are the only official MCPX wallets. They receive the operations and platform shares of the fee split above. Treat any other address claiming to be MCPX as fake.</p>
            <ul className="space-y-2">
              {([
                ["Deployer", "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2", "Launches and manages MCPX tokens"],
                ["MCPX operations", "5MzN9A2h4w4RdYvwDXUv8ssvJiPPJa9bnamh6yMWFqh5", "Receives the 25% tool operations share"],
                ["MCPX platform", "CqaJhS4BKK791cv2fSsbbc75difqCrTiwkzeeR8WqJVB", "Receives the 15% platform share"],
              ] as [string, string, string][]).map(([label, addr, role]) => (
                <li key={addr} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card p-3">
                  <span className="w-32 shrink-0 text-sm font-medium text-foreground">{label}</span>
                  <code className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">{addr}</code>
                  <CopyButton text={addr} label="Copy" />
                  <span className="w-full text-xs text-subtle">{role}</span>
                </li>
              ))}
            </ul>
            <p>The $MCP mint address will be listed here once $MCP is minted. $MCP has not been minted yet and has no contract address.</p>
          </Doc>

          <Doc id="rewards" title="$MCP holder rewards" planned>
            <p>Creator fees actually collected on $MCP itself are split:</p>
            <ul className="grid gap-2 sm:grid-cols-3">
              {[["30%", "Holders, paid in SOL"], ["30%", "$MCP buybacks, distributed to holders"], ["40%", "Operations"]].map(([p, l]) => (
                <li key={l} className="rounded-md border border-border bg-card p-3"><span className="font-mono text-lg text-foreground">{p}</span><span className="block text-sm">{l}</span></li>
              ))}
            </ul>
            <p>Rewards are processed in five-minute cycles, and only payouts confirmed onchain appear on the <Link to="/treasury" className="text-foreground hover:underline">Treasury</Link> page. Bought-back $MCP goes to eligible holders; it is not burned or held. There is no APY and no guaranteed return.</p>
            <h3 className="pt-2 text-sm font-semibold text-foreground">Who is eligible</h3>
            <p>Any wallet holding $MCP at the moment a cycle is calculated is eligible for that cycle. There is no staking, no locking and no sign-up: eligibility comes straight from the onchain holder list. Your share is proportional to your balance relative to all eligible holders in that cycle. If you buy or sell between cycles, the next cycle simply uses the new holder list.</p>
            <h3 className="pt-2 text-sm font-semibold text-foreground">How it works technically</h3>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>An automated service reads finalized onchain fee events for $MCP. Unconfirmed transactions are never counted.</li>
              <li>Every five minutes it takes the current holder list from the token's onchain history and calculates each wallet's proportional share of the fees collected in that window.</li>
              <li>The 30/30/40 split is applied: SOL payouts to holders, a buyback of $MCP that is routed to holders, and the operations share.</li>
              <li>Each window is recorded in a single sealed database transaction, so a cycle can never be paid twice or skipped silently, and a crash mid-cycle safely resumes.</li>
              <li>Payout transactions are built, validated and signed by the service, then sent onchain. Only payouts confirmed onchain are shown on the Treasury page.</li>
            </ol>
            <p>Rewards are sent automatically to eligible holder wallets; there is nothing to claim. The service holds no user funds between cycles and cannot change the split, which is fixed by the protocol.</p>
          </Doc>

          <Doc id="status" title="Current availability">
            <p><span className="text-foreground">Available now:</span> the ten read-only tools, Canvas setup with saved drafts and test runs, wallet connection, creator sign-in, launch drafts, the invite-only platform test endpoint, and the Treasury page.</p>
            <p><span className="text-foreground">Not live yet:</span> $MCP has not been minted and has no contract address. Token launches, product endpoints, creator earnings and $MCP holder rewards start once $MCP launches.</p>
          </Doc>
        </div>
      </PageContainer>
    </>
  );
}
