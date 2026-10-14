import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer, SectionHeading, SectionLabel, StatusMessage, RouteError, buttonPrimary, buttonOutline } from "@/components/mcpx/primitives";
import { ToolRail } from "@/components/mcpx/ToolRail";
import { LiveFlow, ChildFlow } from "@/components/mcpx/LiveFlow";
import { TreasuryModule } from "@/components/mcpx/treasury/TreasuryModule";

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
  { n: "01", t: "Choose a tool", d: "Pick one of ten live Solana tools, or Canvas to chain them.", s: "Available now", live: true },
  { n: "02", t: "Configure it", d: "Set the name, details and pipeline. Saved as your draft.", s: "Available now", live: true },
  { n: "03", t: "Create the token", d: "A child token paired to $MCP, fees split 60/25/15.", s: "Not live yet", live: false },
  { n: "04", t: "Run it", d: "Use it on site or connect it from an MCP client.", s: "Available now", live: true },
];

const CAPS = [
  { tag: "Build", t: "Build a tool that runs today", d: "Ten read-only Solana tools run live on site. Chain 2–4 of them into a Canvas pipeline that passes real addresses from one step to the next.", s: "Available now", live: true },
  { tag: "Connect", t: "Plug it into any AI client", d: "Each tool exposes its own MCP endpoint, so MCP-compatible clients and agents can call it directly. Six are wired up today; the rest follow.", s: "6 of 10 live", live: true },
  { tag: "Pair", t: "Pair it with a $MCP token", d: "Launch a tool with a child token paired to $MCP. Fees actually collected split 60% creator, 25% operations, 15% platform.", s: "Not live yet", live: false },
];

function Home() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border bg-grid">
        <PageContainer className="py-14 sm:py-20 lg:py-24">
          <div className="max-w-5xl animate-rise">
            <SectionLabel>CREATOR FEES PAY HOLDERS</SectionLabel>
            <h1 className="mt-6 font-mono text-5xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
              <span className="block">Hold <span className="text-primary">$MCP</span>.</span>
              <span className="block">Share in the ecosystem.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Every native $MCP trade can generate creator fees. 60% of fees actually collected are allocated to eligible holders: 30% in SOL and 30% through $MCP buybacks and distributions. Processed in five-minute cycles.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link to="/dashboard" className={buttonPrimary}>My Rewards</Link>
              <Link to="/mcp" className={buttonOutline}>MCP Library</Link>
            </div>
          </div>
        </PageContainer>
      </section>

      <section aria-labelledby="status" className="border-b border-border">
        <PageContainer className="py-12 sm:py-14">
          <SectionHeading label="Live flow" title={<span id="status">From every trade to every holder</span>} intro="Fees collected from native $MCP trades flow into MCPX, then out to eligible wallets in SOL and bought-back $MCP." />
          <div className="mt-8"><LiveFlow /></div>
          <div className="mt-6"><ChildFlow /></div>
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
          <SectionHeading label="How it works" title={<span id="flow">From template to working tool</span>} intro="Four steps from picking a tool to running it. Choosing, configuring and running work today. Creating a token is not live yet." />
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
