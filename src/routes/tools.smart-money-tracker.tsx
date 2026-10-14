import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { QUOTA_HELP, ToolErrorBox, ToolStatusBanner, postTool } from "@/components/mcpx/MintToolShell";
import { shortAddress } from "@/lib/wallet/state";
import { smartMoneyTrackerStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { SMT_CLIENT_TIMEOUT_MS, SMT_ENDPOINT, SMT_MAX_WALLETS, type Detail, type SmartMoneyResult, type SmtWallet } from "@/lib/tools/smart-money-tracker";
import { SmartMoneyResultView } from "@/components/mcpx/results/smart-money-tracker";

export const Route = createFileRoute("/tools/smart-money-tracker")({
  head: () => ({
    meta: [
      { title: "Smart Money Tracker — MCPX" },
      { name: "description", content: "On-demand recent activity for up to 3 Solana wallets you choose: signatures and native SOL transfers, larger moves highlighted. Not monitoring." },
      { property: "og:title", content: "Smart Money Tracker — MCPX" },
      { property: "og:description", content: "Tracked wallet activity for wallets you pick — bounded, sourced, read-only." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
  errorComponent: RouteError,
});

function Page() {
  const status = useQuery(smartMoneyTrackerStatusQuery);
  const [inputs, setInputs] = useState(["", "", ""]);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (wallets: string[]) => { abort.current?.abort(); abort.current = new AbortController(); return postTool<SmartMoneyResult>(SMT_ENDPOINT, { wallets }, abort.current.signal, SMT_CLIENT_TIMEOUT_MS); },
    retry: false,
  });
  const filled = inputs.map((s) => s.trim()).filter(Boolean);
  const invalid = filled.filter((a) => !isValidSolanaAddress(a));
  const dup = new Set(filled).size !== filled.length;
  const ok = filled.length >= 1 && invalid.length === 0 && !dup;
  const available = status.data?.available === true;

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · Intelligence" title="Smart Money Tracker" intro="Tracked wallet activity for up to 3 wallets you choose — recent signatures and native SOL transfers, read once when you press the button." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">Not a 24/7 monitor, alert or copy-trading tool, and it doesn't say whether these wallets are "smart". It samples the latest 20 signatures per wallet and decodes the newest 5; token transfers, swaps and profit are not shown.</p>
        <ToolStatusBanner name="Smart Money Tracker" status={status} />
        {available && (
          <form onSubmit={(e) => { e.preventDefault(); if (ok && !run.isPending) run.mutate(filled); }} className="max-w-2xl space-y-3" noValidate>
            {inputs.map((v, i) => (
              <div key={i}>
                <label htmlFor={`smt-${i}`} className="label-mono block text-xs text-subtle">Wallet {i + 1}{i > 0 ? " (optional)" : ""}</label>
                <input id={`smt-${i}`} value={v} onChange={(e) => setInputs((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} maxLength={60} autoComplete="off" spellCheck={false}
                  aria-invalid={!!v.trim() && !isValidSolanaAddress(v.trim())}
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary" placeholder="Base58 wallet address" />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {invalid.length ? <span className="text-warning">{invalid.length} address{invalid.length > 1 ? "es aren't" : " isn't"} a valid Solana public key.</span> : dup ? <span className="text-warning">The same wallet is entered twice.</span> : `Up to ${SMT_MAX_WALLETS} wallets; one check = one free test. ${QUOTA_HELP}`}
            </p>
            <button type="submit" className={buttonPrimary} disabled={!ok || run.isPending}>{run.isPending ? "Checking…" : "Track Wallets"}</button>
          </form>
        )}
        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isError && <ToolErrorBox error={run.error} onRetry={() => run.variables && run.mutate(run.variables)} />}
          {run.data && !run.isPending && <SmartMoneyResultView r={run.data} />}
        </div>
        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}
