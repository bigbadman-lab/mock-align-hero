import { useState } from "react";
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

const C_OUT: (Node & { pct: string; tone: "primary" | "muted"; path: string })[] = [
  { x: 880, y: 90, label: "Tool creator", sub: "creator wallet", pct: "60%", tone: "primary", path: "M580 200 C 690 200, 710 90, 800 90" },
  { x: 880, y: 220, label: "Tool operations", sub: "keeps the MCP running", pct: "25%", tone: "primary", path: "M585 220 L 800 220" },
  { x: 880, y: 350, label: "MCPX platform", sub: "protocol", pct: "15%", tone: "muted", path: "M580 240 C 690 240, 710 350, 800 350" },
];

/** Child-token flow: traders buy a child token with $MCP, its fees split 60/25/15, and the token powers a live MCP tool. */
export function ChildFlow() {
  const p1 = "M165 220 L 225 220";
  const p2 = "M375 220 L 435 220";
  const tool = "M510 300 L 510 352";
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card/40 p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="label-mono inline-flex items-center gap-2 text-primary">
          <span aria-hidden className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          Child token flow · paired to $MCP
        </span>
        <span className="label-mono text-subtle">Illustration · child launches not live yet</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 1000 470" role="img" aria-label="Traders buy a child token using $MCP. The child token's creator fees split 60% to the tool creator, 25% to tool operations and 15% to the MCPX platform. Every child token powers its own live MCP tool." className="min-w-[680px] w-full">
          <style>{`
            .cf-line{stroke-dasharray:6 8;animation:cf-dash 1.2s linear infinite}
            @keyframes cf-dash{to{stroke-dashoffset:-28}}
            .cf-glow{animation:cf-pulse 2.4s ease-in-out infinite;transform-origin:510px 220px}
            @keyframes cf-pulse{0%,100%{opacity:.25;transform:scale(.92)}50%{opacity:.6;transform:scale(1.06)}}
            .cf-blink{animation:cf-blink 1.6s steps(2) infinite}
            @keyframes cf-blink{50%{opacity:.2}}
            @media (prefers-reduced-motion: reduce){.cf-line,.cf-glow,.cf-blink{animation:none}.lf-dot{display:none}}
          `}</style>

          {[p1, p2].map((p) => <path key={p} d={p} fill="none" className="stroke-primary cf-line" strokeWidth={2} />)}
          {C_OUT.map((o) => <path key={o.path} d={o.path} fill="none" className={`${o.tone === "primary" ? "stroke-primary" : "stroke-muted-foreground"} cf-line`} strokeWidth={2} />)}
          <path d={tool} fill="none" className="stroke-primary cf-line" strokeWidth={2} />

          <Dots path={p1} dur={1.1} cls="fill-primary" count={2} />
          <Dots path={p2} dur={1.1} cls="fill-primary" count={2} />
          {C_OUT.map((o, i) => <Dots key={i} path={o.path} dur={2.2 + i * 0.2} cls={o.tone === "primary" ? "fill-primary" : "fill-muted-foreground"} />)}
          <Dots path={tool} dur={0.9} cls="fill-primary" count={2} />

          <Box n={{ x: 90, y: 220, label: "Traders", sub: "buy with $MCP" }} />
          <Box n={{ x: 300, y: 220, label: "Child token", sub: "$MCP-paired pool" }} />

          <circle cx={510} cy={220} r={80} className="fill-primary cf-glow" opacity={0.3} style={{ filter: "blur(18px)" }} />
          <circle cx={510} cy={220} r={66} className="fill-background stroke-primary" strokeWidth={1.5} />
          <defs><clipPath id="cf-hub"><circle cx={510} cy={220} r={64} /></clipPath></defs>
          <image href={logo.url} clipPath="url(#cf-hub)" x={510 - 90} y={220 - 90} width={180} height={180} style={{ imageRendering: "pixelated" }} />
          <text x={510} y={150 - 6} textAnchor="middle" className="fill-foreground" fontSize={13} fontWeight={600}>Child creator fees</text>

          <g transform="translate(390 352)">
            <rect width={240} height={96} rx={8} className="fill-card stroke-primary" strokeWidth={1.5} />
            <circle cx={20} cy={22} r={4} className="fill-primary cf-blink" />
            <text x={32} y={26} className="fill-primary" fontSize={11} fontFamily="var(--font-mono, monospace)" fontWeight={600}>LIVE MCP TOOL</text>
            <text x={20} y={52} className="fill-foreground" fontSize={14} fontWeight={600}>Every child token runs a tool</text>
            <text x={20} y={74} className="fill-muted-foreground" fontSize={11} fontFamily="var(--font-mono, monospace)">/api/public/mcp/&lt;token&gt;</text>
          </g>

          {C_OUT.map((o) => (
            <g key={o.y}>
              <text x={o.x - 170} y={o.y - 12} className={o.tone === "primary" ? "fill-primary" : "fill-muted-foreground"} fontSize={13} fontFamily="var(--font-mono, monospace)" fontWeight={600}>{o.pct}</text>
              <Box n={o} w={170} />
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

const TABS = [
  { id: "native", label: "$MCP flow" },
  { id: "child", label: "Child token flow" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Toggles between the native $MCP fee flow and the child-token fee flow. */
export function FlowToggle() {
  const [tab, setTab] = useState<TabId>("native");
  return (
    <div>
      <div role="tablist" aria-label="Fee flow type" className="mb-6 inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card/60 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`label-mono rounded-md px-4 py-2 transition-colors ${
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "native" ? <LiveFlow /> : <ChildFlow />}
    </div>
  );
}
