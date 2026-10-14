import logo from "@/assets/mcp-monitor-logo.png.asset.json";

// Illustrative diagram only — no live data. Tools orbit the $MCP core;
// fee pulses travel inward from tools, then out to holders and operations.
const TOOLS = ["Wallet Inspector", "Whale Watch", "Token Scanner", "Supply Monitor", "TX Verifier", "Canvas"];
const C = 200;
const R = 140;

const OUTS = [
  { label: "Holders · SOL", pct: "30%", x: 40, y: 375, tone: "fill-primary" },
  { label: "Buybacks → holders", pct: "30%", x: 200, y: 392, tone: "fill-primary" },
  { label: "Operations", pct: "40%", x: 360, y: 375, tone: "fill-muted-foreground" },
];

export function HeroOrbit() {
  return (
    <div className="relative mx-auto w-full max-w-[460px]" aria-label="Diagram: MCP tools orbit the $MCP core and fees flow to holders" role="img">
      <svg viewBox="0 0 400 420" className="h-auto w-full overflow-visible">
        <defs>
          <radialGradient id="ho-glow">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx={C} cy={C} r={110} fill="url(#ho-glow)" className="ho-pulse" />
        <circle cx={C} cy={C} r={R} className="fill-none stroke-border" strokeDasharray="2 6" />
        <circle cx={C} cy={C} r={R - 50} className="fill-none stroke-border" strokeOpacity={0.5} />

        {/* outflow lines */}
        {OUTS.map((o) => (
          <g key={o.label}>
            <path d={`M${C} ${C + 40} L ${o.x} ${o.y - 18}`} className="stroke-border" strokeDasharray="3 4" fill="none" />
            <circle r={3.5} className={o.tone}>
              <animateMotion dur="2.4s" repeatCount="indefinite" path={`M${C} ${C + 40} L ${o.x} ${o.y - 18}`} />
            </circle>
          </g>
        ))}

        {/* rotating orbit of tools */}
        <g className="ho-spin" style={{ transformOrigin: `${C}px ${C}px` }}>
          {TOOLS.map((t, i) => {
            const a = (i / TOOLS.length) * Math.PI * 2 - Math.PI / 2;
            const x = C + R * Math.cos(a);
            const y = C + R * Math.sin(a);
            return (
              <g key={t}>
                <circle r={3} className="fill-primary">
                  <animateMotion dur="1.8s" begin={`${i * 0.3}s`} repeatCount="indefinite" path={`M${x} ${y} L ${C} ${C}`} />
                </circle>
                <g transform={`translate(${x} ${y})`}>
                  <g className="ho-counter">
                    <rect x={-48} y={-13} width={96} height={26} rx={6} className="fill-card stroke-border" />
                    <circle cx={-38} cy={0} r={2.5} className="fill-primary" />
                    <text x={4} y={4} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono, monospace)" className="fill-foreground">{t}</text>
                  </g>
                </g>
              </g>
            );
          })}
        </g>

        {/* core */}
        <circle cx={C} cy={C} r={42} className="fill-card stroke-primary" strokeWidth={1.5} />
        <image href={logo.url} x={C - 28} y={C - 28} width={56} height={56} />
        <text x={C} y={C + 62} textAnchor="middle" fontSize={12} fontWeight={600} fontFamily="var(--font-mono, monospace)" className="fill-primary">$MCP</text>

        {OUTS.map((o) => (
          <g key={o.pct + o.label} transform={`translate(${o.x} ${o.y})`}>
            <text textAnchor="middle" fontSize={14} fontWeight={600} fontFamily="var(--font-mono, monospace)" className={o.tone}>{o.pct}</text>
            <text y={14} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono, monospace)" className="fill-muted-foreground">{o.label}</text>
          </g>
        ))}
      </svg>
      <p className="label-mono mt-2 text-center text-subtle">Tools → fees → $MCP → holders · illustrative</p>
    </div>
  );
}
