import { createFileRoute } from "@tanstack/react-router";
import { PageContainer, RouteError } from "@/components/mcpx/primitives";
import { WhitepaperContent } from "@/components/mcpx/whitepaper/WhitepaperContent";
import { CopyVision } from "@/components/mcpx/whitepaper/CopyVision";

export const Route = createFileRoute("/whitepaper")({
  head: () => ({
    meta: [
      { title: "Whitepaper — MCPX | Token-Powered Applications" },
      { name: "description", content: "Read MCPX’s working whitepaper: a proposed open marketplace for token-powered applications, MCP tools and transparent developer participation." },
      { property: "og:title", content: "Whitepaper — MCPX | Token-Powered Applications" },
      { property: "og:description", content: "Explore MCPX’s product foundation, proposed community marketplace and vision for token-powered applications." },
      { property: "og:type", content: "article" },
      { property: "og:url", content: "https://mcpx.fun/whitepaper" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://mcpx.fun/whitepaper" }],
  }),
  component: WhitepaperPage,
  errorComponent: RouteError,
});

function WhitepaperPage() {
  return (
    <PageContainer className="max-w-3xl py-10 sm:py-16">
      <header className="mb-10 border-b border-border pb-9 sm:mb-12 sm:pb-10">
        <p className="font-mono text-xs text-muted-foreground">Whitepaper · Working Draft v0.1 · October 2026</p>
        <h1 className="mt-6 font-mono text-4xl font-semibold text-foreground sm:text-5xl">MCPX</h1>
        <p className="mt-3 max-w-xl text-2xl font-medium leading-snug text-foreground sm:text-3xl">The Open Marketplace for Token-Powered Applications</p>
        <p className="mt-5 text-base leading-7 text-muted-foreground">Build a tool. Launch a token. Share in its success.</p>
        <div className="mt-7"><CopyVision /></div>
      </header>
      <article aria-label="MCPX Whitepaper"><WhitepaperContent /></article>
    </PageContainer>
  );
}