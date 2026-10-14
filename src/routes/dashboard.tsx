import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Activity, Boxes, Coins, Copy, Check, LayoutGrid, LogOut, Repeat, ShieldCheck, Wallet, Workflow } from "lucide-react";
import { CreatorProducts } from "@/components/mcpx/CreatorSignIn";
import { CanvasWorkspace } from "@/components/mcpx/dashboard/CanvasWorkspace";
import { useCopy } from "@/components/mcpx/wallet/WalletControls";
import { PageContainer, PageHeader, FeatureAvailability, RouteError, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { safeNext, sessionMatchesWallet, useCreatorSessionContext } from "@/lib/creator-auth/session-context";
import { useWallet } from "@/lib/wallet/context";
import { shortAddress } from "@/lib/wallet/state";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — MCPX" },
      { name: "description", content: "Manage your MCP products, track activity and view rewards on MCPX." },
      { property: "og:title", content: "Dashboard — MCPX" },
      { property: "og:description", content: "Manage your MCP products, track activity and view rewards." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
  errorComponent: RouteError,
});

// Status-honest previews. Nothing here claims a live balance or record.
const AREAS = [
  { id: "products", icon: Boxes, title: "Your MCP Products", body: "Manage keys and settings for tools linked to your verified token launches.", status: "Available" },
  { id: "canvas", icon: Workflow, title: "Canvas Workspace", body: "Edit the pipeline of your launched Canvas products.", status: "After launch" },
  { id: "earnings", icon: Coins, title: "Creator Earnings", body: "Your 60% share of child-token creator fees.", status: "Not live yet" },
  { id: "rewards", icon: LayoutGrid, title: "Native $MCP Rewards", body: "SOL and $MCP paid to eligible holders.", status: "Not live yet" },
  { id: "activity", icon: Activity, title: "Tool Activity", body: "Runs of your MCP tools once your token is live.", status: "Not live yet" },
] as const;

const REASSURE = "Wallet verification signs a readable message. No transaction, gas fee or funds transfer.";

export function Dashboard() {
  const w = useWallet();
  const session = useCreatorSessionContext();
  const connected = w.status === "connected_mainnet" || w.status === "connected_unsupported_network";
  const restoring = w.status === "loading" || session.s === "checking" || (session.s === "signed_in" && w.status === "connecting");
  const authed = sessionMatchesWallet(session, w);

  let body: ReactNode;
  if (restoring && !authed) body = <Skeleton />;
  else if (authed) body = <Authenticated />;
  else if (connected) body = <Unverified />;
  else body = <Disconnected />;

  return (
    <>
      <PageHeader label="Account" title="Dashboard" className="py-8 sm:py-10" intro="Manage your MCP products, track activity and view rewards." />
      <PageContainer className="space-y-6 py-8">{body}</PageContainer>
    </>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your dashboard" className="space-y-4">
      <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-lg border border-border bg-card" />)}
      </div>
    </div>
  );
}

function Note() {
  const session = useCreatorSessionContext();
  const text = session.pending ?? session.note;
  return <p role="status" aria-live="polite" className={cn("min-h-5 text-sm", session.note && !session.pending ? "text-warning" : "text-muted-foreground")}>{text ?? ""}</p>;
}

function Hero({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby="d-hero" className="relative overflow-hidden rounded-xl border border-border-strong bg-card p-6 sm:p-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid opacity-60" />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start">
        <div aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-primary/40 bg-primary/10 text-primary">{icon}</div>
        <div className="min-w-0 flex-1 space-y-4">
          <h2 id="d-hero" className="text-xl font-semibold text-foreground sm:text-2xl">{title}</h2>
          {children}
        </div>
      </div>
    </section>
  );
}

function Disconnected() {
  const w = useWallet();
  const unavailable = w.status === "unavailable";
  return (
    <>
      <Hero icon={<Wallet className="h-6 w-6" />} title="Your creator workspace">
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          Connect your Solana wallet to access your products, manage integrations and track your activity across MCPX.
        </p>
        {unavailable ? (
          <div className="space-y-2">
            <p className="text-sm text-warning">{w.message}</p>
            <button type="button" onClick={() => window.location.reload()} className={buttonOutline}>Reload to retry</button>
          </div>
        ) : (
          <button type="button" onClick={w.open} disabled={!w.open} className={buttonPrimary} aria-live="polite">
            {w.status === "connecting" ? "Connecting…" : w.status === "error" ? "Retry Connect & Sign In" : "Connect & Sign In"}
          </button>
        )}
        <p className="flex items-center gap-2 text-xs text-subtle"><ShieldCheck aria-hidden className="h-3.5 w-3.5 text-primary" />{REASSURE}</p>
      </Hero>
      <AreaGrid />
    </>
  );
}

function AreaGrid() {
  return (
    <section aria-labelledby="d-areas">
      <h2 id="d-areas" className="label-mono mb-3 text-subtle">What's inside</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {AREAS.map(({ id, icon: Icon, title, body, status }) => (
          <li key={id} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-border-strong">
            <Icon aria-hidden className="h-5 w-5 text-primary" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">{title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
            </div>
            <span className="mt-auto font-mono text-[11px] uppercase tracking-wider text-subtle">{status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AddressChip() {
  const w = useWallet();
  const { msg, copy } = useCopy();
  if (!w.address) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground" title={w.address}>
        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", w.status === "connected_mainnet" ? "bg-primary" : "bg-warning")} />
        <span className="truncate">{shortAddress(w.address)}</span>
      </span>
      <button type="button" onClick={() => void copy(w.address!)} className={cn(buttonOutline, "min-h-10 px-3")} aria-label="Copy wallet address">
        {msg === "Copied" ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
      </button>
      <span className="text-xs text-muted-foreground">
        {w.walletName ? `${w.walletName} · ` : ""}{w.status === "connected_mainnet" ? "Solana mainnet" : <span className="text-warning">Wrong network</span>}
      </span>
      <span role="status" className="sr-only">{msg}</span>
    </div>
  );
}

function WalletActions() {
  const w = useWallet();
  return (
    <>
      <button type="button" onClick={() => (w.openAccount ?? w.open)?.()} className={cn(buttonOutline, "gap-2")}><Repeat aria-hidden className="h-4 w-4" />Switch wallet</button>
      <button type="button" onClick={() => w.disconnect?.()} className={cn(buttonOutline, "gap-2")}><LogOut aria-hidden className="h-4 w-4" />Disconnect</button>
    </>
  );
}

function Unverified() {
  const w = useWallet();
  const session = useCreatorSessionContext();
  const navigate = useNavigate();
  const wrongNet = w.status === "connected_unsupported_network";
  const verify = async () => {
    if (await session.signIn()) {
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      if (next) void navigate({ to: next });
    }
  };
  return (
    <>
      <Hero icon={<ShieldCheck className="h-6 w-6" />} title="One more step">
        <AddressChip />
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          Verify this wallet to open your workspace. You'll sign one readable message that proves you control the wallet — it cannot move funds.
        </p>
        <div className="flex flex-wrap gap-3">
          {wrongNet ? (
            <button type="button" onClick={w.switchToMainnet} className={buttonPrimary}>Switch to Solana mainnet</button>
          ) : (
            <button type="button" onClick={() => void verify()} disabled={!!session.pending || !w.signMessage} className={buttonPrimary}>
              {session.pending ? "Check your wallet…" : "Verify Wallet"}
            </button>
          )}
          <WalletActions />
        </div>
        <Note />
        <p className="flex items-center gap-2 text-xs text-subtle"><ShieldCheck aria-hidden className="h-3.5 w-3.5 text-primary" />{REASSURE}</p>
      </Hero>
      <AreaGrid />
    </>
  );
}

function Section({ id, title, status, children }: { id: string; title: string; status?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-base font-semibold text-foreground">{title}</h2>
        {status && <FeatureAvailability>{status}</FeatureAvailability>}
      </div>
      {children}
    </section>
  );
}

function Authenticated() {
  const session = useCreatorSessionContext();
  return (
    <>
      <section aria-label="Wallet status" className="flex flex-col gap-4 rounded-xl border border-border-strong bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium text-primary"><ShieldCheck aria-hidden className="h-4 w-4" />Verified creator</p>
          <AddressChip />
          {session.expiresAt && <p className="text-xs text-subtle">Verified until {new Date(session.expiresAt).toLocaleString()}</p>}
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void session.signOut()} className={buttonOutline}>Sign out</button>
          <WalletActions />
        </div>
      </section>

      <Section id="d-creations" title="Verified MCP creations" status="Creator only">
        <CreatorProducts />
      </Section>

      <CanvasWorkspace />

      <div className="grid gap-3 md:grid-cols-3">
        <Pending id="d-earn" icon={<Coins className="h-5 w-5" />} title="Creator earnings" reason="Not live yet — appears once your token earns creator fees." />
        <Pending id="d-rew" icon={<LayoutGrid className="h-5 w-5" />} title="Native rewards" reason="Not live yet — $MCP has not been minted." />
        <Pending id="d-act" icon={<Activity className="h-5 w-5" />} title="Tool activity" reason="Not live yet — appears after a verified token launch." />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link to="/launch" className={buttonPrimary}>Launch a token</Link>
        <Link to="/paired" className={buttonOutline}>Verified registry</Link>
        <Link to="/docs" className={buttonOutline}>Docs</Link>
      </div>
    </>
  );
}

function Pending({ id, icon, title, reason }: { id: string; icon: ReactNode; title: string; reason: string }) {
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div aria-hidden className="text-subtle">{icon}</div>
      <h2 id={id} className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>
    </section>
  );
}
