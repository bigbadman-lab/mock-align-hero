import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer, SectionHeading, SectionLabel, StatusMessage, RouteError, buttonPrimary, buttonOutline } from "@/components/mcpx/primitives";
import { ToolRail } from "@/components/mcpx/ToolRail";
import { FlowToggle } from "@/components/mcpx/LiveFlow";
import { HeroOrbit } from "@/components/mcpx/HeroOrbit";
import { TrustBadges } from "@/components/mcpx/TrustBadges";
import { TreasuryModule } from "@/components/mcpx/treasury/TreasuryModule";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MCPX — Launch a token. Make it useful." },
      { name: "description", content: "Launch on Solana with a working AI application or onchain tool built in. Every token gets its own interactive product and MCP endpoint." },
      { property: "og:title", content: "MCPX — Launch a token. Make it useful." },
      { property: "og:description", content: "The token-powered app launchpad on Solana: every token gets its own interactive product and MCP endpoint." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
  errorComponent: RouteError,
});

const FLOW = [
  { n: "01", t: "Choose a tool", d: "Pick one of ten live Solana tools, or Canvas to chain them.", s: "Available now", live: true },
  { n: "02", t: "Configure it", d: "Set the name, details and pipeline. Saved as your draft.", s: "Available now", live: true },
  { n: "03", t: "Create the token", d: "A child token paired to $MCP, fees split 60/25/15.", s: "Available now", live: true },
  { n: "04", t: "Run it", d: "Use it on site or connect it from an MCP client.", s: "Available now", live: true },
];

const CAPS = [
  { tag: "Build", t: "Build a tool that runs today", d: "Ten read-only Solana tools run live on site. Chain 2–4 of them into a Canvas pipeline that passes real addresses from one step to the next.", s: "Available now", live: true },
  { tag: "Connect", t: "Plug it into any AI client", d: "Each tool exposes its own MCP endpoint, so MCP-compatible clients and agents can call it directly. Six are wired up today; the rest follow.", s: "6 of 10 live", live: true },
  { tag: "Pair", t: "Pair it with a $MCP token", d: "Launch a tool with a child token paired to $MCP. Fees actually collected split 60% creator, 25% operations, 15% platform.", s: "Available now", live: true },
];

function Home() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border bg-grid">
        <PageContainer className="py-8 sm:py-12 lg:py-14">
          <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="max-w-5xl animate-rise">
            <SectionLabel>MCPX · THE TOKEN-POWERED APP LAUNCHPAD</SectionLabel>
            <h1 className="mt-4 font-mono text-4xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              <span className="block">Where tokens become</span>
              <span className="block text-primary">applications.</span>
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Discover and launch token-powered AI applications and MCP tools. Every token comes with a working product you can use on the web or connect to your AI agents.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/launch" className={buttonPrimary}>Launch a Token</Link>
              <Link to="/mcp" className={buttonOutline}>Explore MCP Tools</Link>
            </div>
            <ul className="mt-6 grid max-w-xl gap-3 border-t border-border pt-4 sm:grid-cols-3">
              {[
                { t: "Working Apps", d: "Real interactive web interfaces." },
                { t: "MCP-Powered", d: "Connect tools to compatible AI clients." },
                { t: "$MCP Rewards", d: "Five-minute reward cycles." },
              ].map((h) => (
                <li key={h.t}>
                  <p className="label-mono text-primary">{h.t}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{h.d}</p>
                </li>
              ))}
            </ul>
          </div>
          <HeroOrbit />
          </div>
          <TrustBadges />
        </PageContainer>
      </section>

      <section aria-labelledby="rewards" className="border-b border-border">
        <PageContainer className="py-10 sm:py-12">
          <SectionHeading
            label="$MCP rewards"
            title={<span id="rewards">Hold $MCP. Participate in what MCPX builds.</span>}
            intro={<span className="text-sm">Every eligible native $MCP trade can generate creator fees. Of the fees actually collected, 30% is allocated to SOL holder rewards and 30% to $MCP buybacks and distributions, with rewards processed in five-minute cycles. Rewards are automatically sent to eligible holder wallets.</span>}
          />
          <ul className="mt-5 grid gap-2 sm:grid-cols-3">
            {[
              { p: "30%", t: "SOL holder rewards" },
              { p: "30%", t: "$MCP buybacks & distributions" },
              { p: "40%", t: "Operations" },
            ].map((a) => (
              <li key={a.t} className="flex items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2">
                <p className="font-mono text-lg font-semibold text-primary">{a.p}</p>
                <p className="text-sm leading-snug text-muted-foreground">{a.t}</p>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/treasury" className={cn(buttonOutline, "min-h-9 px-4 text-sm")}>Treasury & reward history</Link>
            <Link to="/dashboard" className={cn(buttonOutline, "min-h-9 px-4 text-sm")}>My Rewards</Link>
          </div>
        </PageContainer>
      </section>


      <section aria-labelledby="status" className="border-b border-border">
        <PageContainer className="py-12 sm:py-14">
          <SectionHeading label="Live flow" title={<span id="status">From every trade to every holder</span>} intro="Fees collected from native $MCP trades flow into MCPX, then out to eligible wallets in SOL and bought-back $MCP." />
          <div className="mt-8"><FlowToggle /></div>
        </PageContainer>
      </section>

      <section aria-labelledby="treasury" className="border-b border-border">
        <PageContainer className="py-12 sm:py-14">
          <SectionHeading label="Treasury" title={<span id="treasury">Every fee. Every reward. Fully transparent.</span>} intro="Track native $MCP creator fees, five-minute reward cycles and verified holder distributions — all in one place." />
          <div className="mt-10"><TreasuryModule /></div>
        </PageContainer>
      </section>

      <section aria-labelledby="flow" className="border-b border-border">
        <PageContainer className="py-12 sm:py-14">
          <SectionHeading label="How it works" title={<span id="flow">From template to working tool</span>} intro="Four steps from picking a tool to running it." />
          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FLOW.map((s) => (
              <li key={s.n} className="flex flex-col rounded-lg border border-border bg-card p-6">
                <span className="font-mono text-5xl font-semibold leading-none tracking-tight text-primary">{s.n}</span>
                <p className="mt-5 text-base font-semibold text-foreground">{s.t}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
                <span className={`label-mono mt-6 inline-flex items-center gap-2 ${s.live ? "text-primary" : "text-warning"}`}>
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{s.s}
                </span>
              </li>
            ))}
          </ol>
        </PageContainer>
      </section>

      <section aria-labelledby="tpl" className="border-b border-border">
        <PageContainer className="py-12 sm:py-14">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHeading label="Tool library" title={<span id="tpl">Ten live tools, plus Canvas</span>} intro="Read-only Solana tools you can run today, and Canvas to chain 2–4 of them into one pipeline." />
            <Link to="/mcp" className={buttonOutline}>View all templates</Link>
          </div>
          <ToolRail />
        </PageContainer>
      </section>

      <section aria-labelledby="vision">
        <PageContainer className="py-12 sm:py-14">
          <SectionHeading label="What you can build" title={<span id="vision">Build a live tool. Pair it. Plug it into AI.</span>} intro="Tools run on live Solana data today. Pairing one to a $MCP token is the last piece still in front of you." />
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {CAPS.map((c) => (
              <div key={c.tag} className="flex flex-col rounded-lg border border-border bg-card p-6">
                <p className="label-mono text-primary">{c.tag}</p>
                <h3 className="mt-4 text-lg font-semibold text-foreground">{c.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.d}</p>
                <span className={`label-mono mt-auto pt-6 inline-flex items-center gap-2 ${c.live ? "text-primary" : "text-warning"}`}>
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{c.s}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-subtle">Bring your own AI key to finish a Canvas pipeline with a summary — that step unlocks when your Canvas launches.</p>
        </PageContainer>
      </section>

    </>
  );
}
