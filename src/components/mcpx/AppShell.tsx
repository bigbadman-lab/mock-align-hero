import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { PageContainer } from "./primitives";
import { WalletButton } from "./wallet/WalletControls";
import { countdown } from "@/lib/treasury/core";
import logo from "@/assets/mcpx-logo.png";

export const NAV = [
  { to: "/", label: "Home" },
  { to: "/mcp", label: "MCP" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/paired", label: "Paired" },
  { to: "/treasury", label: "Treasury" },
  { to: "/docs", label: "Docs" },
  { to: "/launch", label: "Launch" },
] as const;

export function Mark() {
  return <img src={logo} alt="" aria-hidden width={32} height={32} className="h-8 w-8 [image-rendering:pixelated]" />;
}

/** Small header countdown to the next 5-minute rewards window (UTC boundary is deterministic). */
function RewardsCountdown() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const c = now === null ? null : countdown(0, now);
  return (
    <Link
      to="/treasury"
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground sm:gap-2 sm:px-3"
      aria-label={`Rewards window — next window in ${c ? `${c.mm}:${c.ss}` : "unknown"}. View Treasury`}
      title="Next 5-minute rewards window"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
      <span className="text-subtle">Rewards</span>
      <span className="tabular-nums text-foreground">{c ? `${c.mm}:${c.ss}` : "--:--"}</span>
    </Link>
  );
}

const linkCls =
  "inline-flex min-h-11 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:text-foreground data-[status=active]:bg-secondary";

function SiteNav() {
  return (
    <nav aria-label="Primary" className="hidden md:block">
      <ul className="flex items-center gap-1">
        {NAV.map((n) => (
          <li key={n.to}>
            <Link to={n.to} activeOptions={{ exact: n.to === "/" }} className={linkCls}>{n.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((o) => !o)}
        className="grid h-11 w-11 place-items-center rounded-md border border-border-strong text-foreground"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>
      {open && (
        <nav id="mobile-nav" aria-label="Primary" className="absolute inset-x-0 top-16 border-b border-border bg-background">
          <ul className="flex flex-col p-3">
            {NAV.map((n) => (
              <li key={n.to}>
                <Link to={n.to} activeOptions={{ exact: n.to === "/" }} onClick={() => setOpen(false)} className={`${linkCls} w-full text-base`}>
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-border p-3"><WalletButton className="w-full" /></div>
        </nav>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <PageContainer className="flex h-16 items-center justify-between gap-4">
          <Link to="/" aria-label="MCPX home" className="flex min-h-11 items-center gap-2.5">
            <Mark />
            <span className="font-mono text-sm font-semibold tracking-[0.2em] text-foreground">MCPX</span>
          </Link>
          <div className="flex items-center gap-3">
            <SiteNav />
            <RewardsCountdown />
            <div className="hidden md:block"><WalletButton /></div>
            <MobileNav />
          </div>
        </PageContainer>
      </header>
      <main id="main" className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <PageContainer className="grid gap-6 py-10 md:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5"><Mark /><span className="font-mono text-sm tracking-[0.2em]">MCPX</span></div>
            <p className="text-sm text-muted-foreground">Every token powers a tool.</p>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
              Create, launch and connect MCP tools on Solana. Powered by $MCP, built for an open ecosystem where creators build, tools deliver utility and holders participate.
            </p>
          </div>
          <nav aria-label="Footer">
            <ul className="grid grid-cols-2 gap-x-5 gap-y-0 sm:grid-cols-3">
              {NAV.map((n) => (
                <li key={n.to}><Link to={n.to} className="inline-flex items-center px-1 py-1 text-sm text-muted-foreground hover:text-foreground">{n.label}</Link></li>
              ))}
              <li><Link to="/whitepaper" className="inline-flex items-center px-1 py-1 text-sm text-muted-foreground hover:text-foreground">Whitepaper</Link></li>
              <li><a href="https://x.com/mcpdotfun" target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-1 py-1 text-sm text-muted-foreground hover:text-foreground">X / @mcpdotfun</a></li>
            </ul>
          </nav>
        </PageContainer>
        <PageContainer className="border-t border-border py-4">
          <p className="font-mono text-xs text-subtle">mcpx.fun</p>
        </PageContainer>
      </footer>
    </div>
  );
}
