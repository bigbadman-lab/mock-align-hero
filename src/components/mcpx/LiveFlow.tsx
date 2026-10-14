import logo from "@/assets/mcp-monitor-logo.png.asset.json";

type Node = { x: number; y: number; label: string; sub: string };

const BUY: Node = { x: 90, y: 210, label: "Buyers", sub: "trade $MCP" };
const FEES: Node = { x: 290, y: 210, label: "Creator fees", sub: "actually collected" };
const HUB = { x: 500, y: 210 };
const OUT: (Node & { pct: string; tone: "primary" | "muted"; path: string })[] = [
  { x: 870, y: 70, label: "Eligible holders", sub: "paid in SOL", pct: "30%", tone: "primary", path: "M570 190 C 680 190, 700 70, 790 70" },
  { x: 870, y: 210, label: "Eligible holders", sub: "$MCP buybacks", pct: "30%", tone: "primary", path: "M575 210 L 790 210" },
  { x: 870, y: 350, label: "Operations", sub: "protocol & treasury", pct: "40%", tone: "muted", path: "M570 230 C 680 230, 700 350, 790 350" },
];

function Box({ n, w = 150 }: { n: Node; w?: number }) {
  return (
    <g transform={`translate(${n.x - w / 2} ${n.y - 32})`}>
      <rect width={w} height={64} rx={8} className="fill-card stroke-border" strokeWidth={1} />
      <text x={w / 2} y={28} textAnchor="middle" className="fill-foreground" fontSize={15} fontWeight={600}>{n.label}</text>
      <text x={w / 2} y={47} textAnchor="middle" className="fill-muted-foreground" fontSize={11} fontFamily="var(--font-mono, monospace)">{n.sub}</text>
    </g>
  );
}

function Dots({ path, dur, cls, count = 3 }: { path: string; dur: number; cls: string; count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={4} className={`${cls} lf-dot`}>
          <animateMotion dur={`${dur}s`} begin={`${(-dur * i) / count}s`} repeatCount="indefinite" path={path} />
        </circle>
      ))}
    </>
  );
}

export function LiveFlow() {
  const inPath1 = "M165 210 L 215 210";
  const inPath2 = "M365 210 L 430 210";
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card/40 p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="label-mono inline-flex items-center gap-2 text-primary">
          <span aria-hidden className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          Fee flow · every 5 min
        </span>
        <span className="label-mono text-subtle">Illustration · $MCP not minted yet</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 1000 420" role="img" aria-label="Fees from $MCP buyers flow into MCPX, then 30% to holders in SOL, 30% to holders through $MCP buybacks, and 40% to operations." className="min-w-[680px] w-full">
          <style>{`
            .lf-line{stroke-dasharray:6 8;animation:lf-dash 1.2s linear infinite}
            @keyframes lf-dash{to{stroke-dashoffset:-28}}
            .lf-glow{animation:lf-pulse 2.4s ease-in-out infinite;transform-origin:500px 210px}
            @keyframes lf-pulse{0%,100%{opacity:.25;transform:scale(.92)}50%{opacity:.6;transform:scale(1.06)}}
            @media (prefers-reduced-motion: reduce){.lf-line,.lf-glow{animation:none}.lf-dot{display:none}}
          `}</style>

          {[inPath1, inPath2].map((p) => (
            <path key={p} d={p} fill="none" className="stroke-primary lf-line" strokeWidth={2} />
          ))}
          {OUT.map((o) => (
            <path key={o.path} d={o.path} fill="none" className={`${o.tone === "primary" ? "stroke-primary" : "stroke-muted-foreground"} lf-line`} strokeWidth={2} />
          ))}

          <Dots path={inPath1} dur={1.1} cls="fill-primary" count={2} />
          <Dots path={inPath2} dur={1.1} cls="fill-primary" count={2} />
          {OUT.map((o, i) => (
            <Dots key={i} path={o.path} dur={2.2 + i * 0.2} cls={o.tone === "primary" ? "fill-primary" : "fill-muted-foreground"} />
          ))}

          <Box n={BUY} />
          <Box n={FEES} />

          <circle cx={HUB.x} cy={HUB.y} r={88} className="fill-primary lf-glow" opacity={0.3} style={{ filter: "blur(18px)" }} />
          <circle cx={HUB.x} cy={HUB.y} r={74} className="fill-background stroke-primary" strokeWidth={1.5} />
          <defs><clipPath id="lf-hub"><circle cx={HUB.x} cy={HUB.y} r={72} /></clipPath></defs>
          <image href={logo.url} clipPath="url(#lf-hub)" x={HUB.x - 100} y={HUB.y - 100} width={200} height={200} style={{ imageRendering: "pixelated" }} />
          <text x={HUB.x} y={HUB.y + 104} textAnchor="middle" className="fill-foreground" fontSize={13} fontWeight={600}>MCPX ecosystem</text>

          {OUT.map((o) => (
            <g key={o.y}>
              <text x={o.x - 170} y={o.y - 12} className={o.tone === "primary" ? "fill-primary" : "fill-muted-foreground"} fontSize={13} fontFamily="var(--font-mono, monospace)" fontWeight={600}>{o.pct}</text>
              <Box n={o} w={160} />
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
