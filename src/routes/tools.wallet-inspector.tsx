import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { walletInspectorStatusQuery } from "@/lib/tools/status";
import { WI_CLIENT_TIMEOUT_MS, WI_ENDPOINT, isValidSolanaAddress, type ToolErrorKind, type WalletInspectorResult } from "@/lib/tools/wallet-inspector";

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
};

class ToolError extends Error { constructor(public kind: ToolErrorKind) { super(kind); } }

async function runInspect(address: string, signal: AbortSignal): Promise<WalletInspectorResult> {
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

const PROGRAM_LABEL: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
};
const PAGE = 50;

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
      <PageHeader label="Template tool · WALLET engine" title="Wallet Inspector" intro="Look up any public Solana mainnet address: its SOL balance and the token accounts it holds right now. Read-only. No wallet connection, signature or payment needed." />
      <PageContainer className="space-y-10 py-12">
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
              className="w-full rounded-md border border-border-strong bg-surface-2 px-4 py-3 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
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
              {run.variables && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && <ResultView r={run.data} />}
        </div>

        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

function ResultView({ r }: { r: WalletInspectorResult }) {
  const [shown, setShown] = useState(PAGE);
  const url = explorerAccountUrl(r.address);
  const tokensKnown = r.coverage.splToken && r.coverage.token2022;
  return (
    <section aria-labelledby="wi-result" className="space-y-6 rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="wi-result" className="text-lg font-semibold text-foreground">Result <span className="font-mono text-sm text-muted-foreground">{shortAddress(r.address)}</span></h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      {r.partial && (
        <StatusMessage tone="warning" title="Partial result">
          <ul>{r.warnings.map((w) => <li key={w.part}>{w.message}</li>)}</ul>
          <p>Missing parts are unknown, not zero.</p>
        </StatusMessage>
      )}
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-subtle">Address</dt><dd className="break-all font-mono text-foreground">{r.address}{url && <> · <a href={url} target="_blank" rel="noreferrer" className="underline">Solscan</a></>}</dd></div>
        <div><dt className="text-subtle">SOL balance</dt><dd className="font-mono text-foreground">{r.solBalance ? `${r.solBalance.solUi} SOL (${r.solBalance.lamports} lamports)` : "Unavailable"}</dd></div>
        <div><dt className="text-subtle">Fetched (UTC)</dt><dd className="font-mono text-foreground">{r.fetchedAt}</dd></div>
        <div><dt className="text-subtle">Observed slots ({r.commitment})</dt><dd className="font-mono text-foreground">balance {r.sourceSlots.balance ?? "n/a"} · SPL {r.sourceSlots.splToken ?? "n/a"} · Token-2022 {r.sourceSlots.token2022 ?? "n/a"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Source: {r.source}. Queries may observe different slots; this is not one atomic snapshot. Shows currently open token accounts only — no history, prices or token names.</p>
      <div>
        <h3 className="mb-3 text-sm font-medium text-foreground">Token holdings ({r.tokenHoldings.length} mints)</h3>
        {r.tokenHoldings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tokensKnown ? "No open token accounts on SPL Token or Token-2022." : "Token holdings could not be fully checked."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-subtle"><tr><th className="py-2 pr-4 font-normal">Mint</th><th className="py-2 pr-4 font-normal">Amount</th><th className="py-2 pr-4 font-normal">Raw · decimals</th><th className="py-2 pr-4 font-normal">Program</th><th className="py-2 font-normal">Accounts</th></tr></thead>
              <tbody>
                {r.tokenHoldings.slice(0, shown).map((h) => (
                  <tr key={h.program + h.mint} className="border-t border-border font-mono">
                    <td className="py-2 pr-4"><a href={`https://solscan.io/token/${encodeURIComponent(h.mint)}`} target="_blank" rel="noreferrer" className="underline" title={h.mint}>{shortAddress(h.mint)}</a></td>
                    <td className="py-2 pr-4 text-foreground">{h.amountUi}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{h.amountRaw} · {h.decimals}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{PROGRAM_LABEL[h.program] ?? h.program}</td>
                    <td className="py-2 text-muted-foreground">{h.tokenAccounts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown < r.tokenHoldings.length && <button className={`${buttonOutline} mt-4`} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, r.tokenHoldings.length - shown)} more</button>}
          </div>
        )}
      </div>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
