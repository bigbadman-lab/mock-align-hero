import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { holderIntelligenceStatusQuery, tokenRiskAnalystStatusQuery, accountCheckerStatusQuery, whaleWatchStatusQuery, supplyMonitorStatusQuery, tokenScannerStatusQuery, transactionVerifierStatusQuery, walletInspectorStatusQuery } from "@/lib/tools/status";
import type { LibraryTemplate } from "@/lib/templates";
import { cn } from "@/lib/utils";

// Explicit toolId → status query mapping (relay ids are not derived from catalogue ids).
const STATUS = {
  wallet_inspector: walletInspectorStatusQuery,
  whale_watch: whaleWatchStatusQuery,
  token_scanner: tokenScannerStatusQuery,
  supply_monitor: supplyMonitorStatusQuery,
  transaction_verifier: transactionVerifierStatusQuery,
  account_checker: accountCheckerStatusQuery,
  holder_intelligence: holderIntelligenceStatusQuery,
  token_risk_analyst: tokenRiskAnalystStatusQuery,
} as const;

export function CapabilityRow({ t }: { t: LibraryTemplate }) {
  return (
    <dl className="grid grid-cols-3 gap-2 text-center">
      <Capability label="Run" value={t.toolId ? <ExecutionState toolId={t.toolId} /> : "Not built"} />
      <Capability label="MCP" value={t.mcpAdapter ? "Adapter" : "No"} on={t.mcpAdapter} />
      <Capability label="Launch" value={t.tokenLaunch ? "Draft" : "No"} on={t.tokenLaunch} />
    </dl>
  );
}

/** Shown only for templates the launch form accepts; the link carries the canonical id. */
export function LaunchLink({ t }: { t: LibraryTemplate }) {
  if (!t.tokenLaunch) return null;
  return (
    <Link to="/launch" search={{ template: t.id }} className="text-sm text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">
      Launch with token<span className="sr-only">: {t.name}</span>
    </Link>
  );
}

export function TemplateAction({ t }: { t: LibraryTemplate }) {
  return t.route && t.toolId ? <ToolAction t={t} toolId={t.toolId} route={t.route} /> : <span className="font-mono text-xs text-subtle">Not available yet — no tool to run</span>;
}

function Capability({ label, value, on }: { label: string; value: ReactNode; on?: boolean }) {
  return (
    <div>
      <dt className="label-mono text-[10px] text-subtle">{label}</dt>
      <dd className={cn("mt-1 font-mono text-xs", on ? "text-foreground" : "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

function useAvailable(toolId: string) {
  const q = STATUS[toolId as keyof typeof STATUS];
  const { data, isPending } = useQuery({ ...(q ?? STATUS.wallet_inspector), enabled: !!q });
  return { ready: !!q && !!data?.available, checking: !!q && isPending };
}

function ExecutionState({ toolId }: { toolId: string }) {
  const { ready, checking } = useAvailable(toolId);
  return <span className={ready ? "text-primary" : undefined}>{checking ? "Checking" : ready ? "Live" : "Offline"}</span>;
}

function ToolAction({ t, toolId, route }: { t: LibraryTemplate; toolId: string; route: string }) {
  const { ready, checking } = useAvailable(toolId);
  if (checking) return <span className="font-mono text-xs text-subtle">Checking execution service…</span>;
  if (!ready) return <span className="font-mono text-xs text-subtle">Execution service not connected</span>;
  return (
    <Link to={route as "/tools/token-scanner"} search={{}} className="inline-flex min-h-10 items-center rounded-md border border-border-strong px-4 text-sm text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      Open {t.name} <span aria-hidden className="ml-2">→</span>
    </Link>
  );
}
