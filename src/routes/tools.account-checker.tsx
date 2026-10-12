import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { explorerAccountUrl } from "@/lib/wallet/state";
import { accountCheckerStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { AC_CLIENT_TIMEOUT_MS, AC_ENDPOINT, type AccountCheckerResult, type AccountClass } from "@/lib/tools/account-checker";

export const Route = createFileRoute("/tools/account-checker")({
  head: () => ({
    meta: [
      { title: "Account Checker — MCPX" },
      { name: "description", content: "Check one Solana mainnet account: whether it exists, its owning program, executable flag, lamports and data size. Read-only." },
      { property: "og:title", content: "Account Checker — MCPX" },
      { property: "og:description", content: "Read-only Solana account-state snapshot: existence, owning program, executable, lamports and size at an observed slot." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AccountCheckerPage,
  errorComponent: RouteError,
});

type Kind = "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error" | "unavailable" | "too_large" | "bad_response" | "network";
const ERROR_TEXT: Record<Kind, string> = {
  invalid_input: "That isn't a valid Solana public address.",
  rate_limited: "Too many requests right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error.",
  unavailable: "Account Checker is unavailable right now.",
  too_large: "The provider's answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
};
class ToolError extends Error { constructor(public kind: Kind) { super(kind); } }

async function runCheck(address: string, signal: AbortSignal): Promise<AccountCheckerResult> {
  let r: Response;
  try {
    r = await fetch(AC_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }), signal: AbortSignal.any([signal, AbortSignal.timeout(AC_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !body || !("schema" in body)) {
    const k = body?.["error"] as Kind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return body as unknown as AccountCheckerResult;
}

function AccountCheckerPage() {
  const status = useQuery(accountCheckerStatusQuery);
  const wallet = useWallet();
  const [address, setAddress] = useState("");
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (a: string) => { abort.current?.abort(); abort.current = new AbortController(); return runCheck(a, abort.current.signal); },
    retry: false,
  });
  const trimmed = address.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;
  const stale = !!run.variables && run.variables !== trimmed;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (valid && available && !run.isPending) run.mutate(trimmed);
  };

  return (
    <>
      <PageHeader label="Template tool · VERIFY engine" title="Account Checker" intro="Check one Solana mainnet account: whether it exists, which program owns it, whether it's executable, its lamports and data size — at one observed moment. Read-only." />
      <PageContainer className="space-y-10 py-12">
        <StatusMessage title="What “owner” means on Solana">
          <p>An account's owner is the <strong>program</strong> allowed to change its data — not the person or wallet that controls its funds. A normal wallet is owned by the System Program. Nothing here is a safety or trust judgement.</p>
        </StatusMessage>

        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title="Account Checker is not deployed yet">
            <p>{status.data.reason === "tool_not_deployed" ? "The execution service is running, but its Account Checker update hasn't been deployed yet." : "The execution service isn't connected, so checks can't run."} Nothing is simulated.</p>
          </StatusMessage>
        )}

        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-3" noValidate>
            <label htmlFor="ac-address" className="label-mono block text-xs text-subtle">Solana address</label>
            <input
              id="ac-address" value={address} onChange={(e) => setAddress(e.target.value)} onBlur={() => setTouched(true)}
              maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby="ac-help"
              className="w-full rounded-md border border-border-strong bg-surface-2 px-4 py-3 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="Base58 address"
            />
            <p id="ac-help" className="text-xs text-muted-foreground">
              {touched && trimmed && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : "Mainnet only. Shared limits across all MCPX tools: 6 per minute, 40 per hour."}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>
                {run.isPending ? "Checking…" : "Check Account"}
              </button>
              {wallet.status === "connected_mainnet" && wallet.address && (
                <button type="button" className={buttonOutline} onClick={() => { setAddress(wallet.address!); setTouched(true); }}>Use connected wallet</button>
              )}
            </div>
          </form>
        )}

        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isPending && run.variables && <p className="break-all font-mono text-xs text-muted-foreground">Checking {run.variables}…</p>}
          {run.isError && !stale && (
            <StatusMessage tone="warning" title={(run.error as ToolError).kind === "rate_limited" ? "Rate limited" : "Unable to verify account right now"}>
              <p>{ERROR_TEXT[(run.error as ToolError).kind ?? "provider_error"]} This is not a sign the account doesn't exist or is empty.</p>
              {run.variables && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && !run.isPending && !stale && <ResultView r={run.data} />}
        </div>

        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

const CLASS_TEXT: Record<AccountClass, string> = {
  executable_program: "Executable program account (callable code). This says nothing about who can upgrade it or whether it's audited.",
  system_owned: "System Program–owned account (typical for ordinary wallets).",
  spl_token_owned: "Owned by the SPL Token program (for example a mint or token account). Use Token Scanner or Wallet Inspector for token details.",
  token_2022_owned: "Owned by the Token-2022 program (for example a mint or token account). Use Token Scanner or Wallet Inspector for token details.",
  loader_owned: "Owned by a program loader (for example program data for an upgradeable program).",
  other_program_owned: "Owned by another program. Its meaning depends on that program.",
};

function ResultView({ r }: { r: AccountCheckerResult }) {
  const url = explorerAccountUrl(r.address);
  return (
    <section aria-labelledby="ac-result" className="space-y-6 rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ac-result" className="text-lg font-semibold text-foreground">{r.exists ? "Existing account" : "No account found"}</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.address}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</p>
      {!r.exists ? (
        <StatusMessage tone="warning" title="No account state found at the observed slot">
          <p>The address may be unused or unfunded, or the account may have been closed. This doesn't mean the address is invalid or that it never existed.</p>
        </StatusMessage>
      ) : (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div><dt className="text-subtle">Owning program</dt><dd className="break-all font-mono text-xs text-foreground">{r.owner}{r.owner && explorerAccountUrl(r.owner) && <> · <a className="underline" href={explorerAccountUrl(r.owner)!} target="_blank" rel="noreferrer">Solscan</a></>}</dd></div>
            <div><dt className="text-subtle">Executable</dt><dd className="text-foreground">{r.executable ? "Yes" : "No"}</dd></div>
            <div><dt className="text-subtle">Balance</dt><dd className="break-all font-mono text-foreground">{r.sol} SOL<span className="block text-xs text-muted-foreground">{r.lamports} lamports</span></dd></div>
            <div><dt className="text-subtle">Data size</dt><dd className="font-mono text-foreground">{r.space !== null ? `${r.space} bytes` : <span className="text-muted-foreground">Unavailable</span>}</dd></div>
          </dl>
          {r.classification && <p className="text-sm text-muted-foreground">{CLASS_TEXT[r.classification]}</p>}
        </>
      )}
      <p className="text-xs text-muted-foreground">Observed at slot {r.slot} ({r.commitment}). Fetched (UTC) {r.fetchedAt}. Source: Solana mainnet via Helius. Account data itself is not downloaded or shown.</p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
