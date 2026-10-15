// Trust strip: the stack MCPX is built on and the clients it connects to.
// Names only — no logos, no claims beyond what actually runs today.
const BADGES = [
  { name: "Solana", note: "Tokens and tools run on Solana mainnet" },
  { name: "OpenAI", note: "AI tools run on OpenAI models" },
  { name: "Claude", note: "Connects from Claude and any MCP-compatible client" },
  { name: "MCP", note: "Every tool exposes its own MCP endpoint" },
  { name: "IPFS", note: "Launch artwork is published to IPFS" },
  { name: "Birdeye", note: "Market data from Birdeye, with DexScreener as backup" },
];

export function TrustBadges() {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
      <p className="label-mono text-subtle">Built on</p>
      <ul className="flex flex-wrap items-center gap-2">
        {BADGES.map((b) => (
          <li key={b.name} title={b.note}>
            <span className="label-mono inline-flex items-center gap-2 rounded border border-border bg-card/60 px-2.5 py-1 text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground">
              <span aria-hidden className="h-1 w-1 rounded-full bg-primary" />
              {b.name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
