import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { walletInspectorStatusQuery } from "@/lib/tools/status";
import { WI_CLIENT_TIMEOUT_MS, WI_ENDPOINT, isValidSolanaAddress, type ToolErrorKind, type WalletInspectorResult } from "@/lib/tools/wallet-inspector";
import { WalletInspectorResultView } from "@/components/mcpx/results/wallet-inspector";

export const Route = createFileRoute("/tools/wallet-inspector")({
  head: () => ({
    meta: [
      { title: "Wallet Inspector — MCPX" },
      { name: "description", content: "Inspect any public Solana mainnet wallet's SOL balance and token accounts. Read-only, no wallet connection needed." },
      { property: "og:title", content: "Wallet Inspector — MCPX" },
      { property: "og:description", content: "Read-only Solana mainnet wallet inspection: SOL balance, SPL Token and Token-2022 accounts, with observed slots." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WalletInspectorPage,
  errorComponent: RouteError,
});

const ERROR_TEXT: Record<ToolErrorKind, string> = {
  invalid_input: "That isn't a valid Solana public address.",
  rate_limited: "Too many inspections right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error.",
  unavailable: "Wallet Inspector is unavailable right now.",
  too_large: "This wallet has more token accounts than this tool can safely show (limit 500 per token program).",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  free_limit: "You've used today's 3 free tests of this tool.",
};

class ToolError extends Error { constructor(public kind: ToolErrorKind) { super(kind); } }

async function runInspect(address: string, signal: AbortSignal): Promise<WalletInspectorResultView> {
  let r: Response;
  try {
    r = await fetch(WI_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }), signal: AbortSignal.any([signal, AbortSignal.timeout(WI_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as { error?: string } | WalletInspectorResult | null;
  if (!r.ok || !body || "error" in body) {
    const k = (body && "error" in body ? body.error : undefined) as ToolErrorKind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return body as WalletInspectorResult;
}


function WalletInspectorPage() {
  const status = useQuery(walletInspectorStatusQuery);
  const wallet = useWallet();
  const [address, setAddress] = useState("");
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (a: string) => { abort.current?.abort(); abort.current = new AbortController(); return runInspect(a, abort.current.signal); },
    retry: false,
  });
  const trimmed = address.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid && available && !run.isPending) run.mutate(trimmed);
  };

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · WALLET engine" title="Wallet Inspector" intro="Look up any public Solana mainnet address: its SOL balance and the token accounts it holds right now. Read-only. No wallet connection, signature or payment needed." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          This is a platform-run template tool. It is not a user-created MCP tool, has no token, and nothing here earns fees.
        </p>

        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title="Wallet Inspector is not available yet">
            <p>The execution service isn't connected yet, so inspections can't run. Nothing is simulated.</p>
          </StatusMessage>
        )}

        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-3" noValidate>
            <label htmlFor="wi-address" className="label-mono block text-xs text-subtle">Solana public address</label>
            <input
              id="wi-address" value={address} onChange={(e) => setAddress(e.target.value)} onBlur={() => setTouched(true)}
              maxLength={44} autoComplete="off" spellCheck={false} aria-invalid={touched && !valid} aria-describedby="wi-help"
              className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="Base58 address"
            />
            <p id="wi-help" className="text-xs text-muted-foreground">
              {touched && trimmed && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : "Mainnet only. Limits: 6 per minute and 40 per hour per visitor."}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>
                {run.isPending ? "Inspecting…" : "Inspect wallet"}
              </button>
              {wallet.status === "connected_mainnet" && wallet.address && (
                <button type="button" className={buttonOutline} onClick={() => { setAddress(wallet.address!); setTouched(true); }}>Use connected wallet</button>
              )}
            </div>
          </form>
        )}

        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isError && (
            <StatusMessage tone="warning" title="Inspection failed">
              <p>{ERROR_TEXT[(run.error as ToolError).kind ?? "provider_error"]}</p>
              {(run.error as ToolError).kind === "free_limit" && <FreeLimitNotice />}
              {run.variables && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && <WalletInspectorResultView r={run.data} />}
        </div>

        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}
