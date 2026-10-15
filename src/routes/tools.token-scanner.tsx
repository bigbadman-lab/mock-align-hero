import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { explorerAccountUrl } from "@/lib/wallet/state";
import { tokenScannerStatusQuery } from "@/lib/tools/status";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { TS_CLIENT_TIMEOUT_MS, TS_ENDPOINT, type TokenScannerResult } from "@/lib/tools/token-scanner";

export const Route = createFileRoute("/tools/token-scanner")({
  // Optional ?mint= prefill: kept only if it is a valid key; never triggers a scan.
  validateSearch: z.object({ mint: z.string().optional() }).transform((s) => ({ mint: s.mint && isValidSolanaAddress(s.mint) ? s.mint : undefined })),
  head: () => ({
    meta: [
      { title: "Token Scanner — MCPX" },
      { name: "description", content: "Read one Solana token mint: program, decimals, exact supply, mint and freeze authorities, Token-2022 extensions. Read-only." },
      { property: "og:title", content: "Token Scanner — MCPX" },
      { property: "og:description", content: "Read-only onchain facts for SPL Token and Token-2022 mints. No prices, scores or verdicts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TokenScannerPage,
  errorComponent: RouteError,
});

type Kind = "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error" | "unavailable" | "too_large" | "bad_response" | "network" | "free_limit";
const ERROR_TEXT: Record<Kind, string> = {
  invalid_input: "That isn't a valid Solana public address.",
  rate_limited: "Too many requests right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error.",
  unavailable: "Token Scanner is unavailable right now.",
  too_large: "The provider's answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  free_limit: "You've used today's 3 free tests of this tool.",
};
class ToolError extends Error { constructor(public kind: Kind) { super(kind); } }

async function runScan(mint: string, signal: AbortSignal): Promise<TokenScannerResult> {
  let r: Response;
  try {
    r = await fetch(TS_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint }), signal: AbortSignal.any([signal, AbortSignal.timeout(TS_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !body || !("schema" in body)) {
    const k = body?.["error"] as Kind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return body as unknown as TokenScannerResult;
}

function TokenScannerPage() {
  const search = Route.useSearch();
  const status = useQuery(tokenScannerStatusQuery);
  const [mint, setMint] = useState(search.mint ?? "");
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (m: string) => { abort.current?.abort(); abort.current = new AbortController(); return runScan(m, abort.current.signal); },
    retry: false,
  });
  const trimmed = mint.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (valid && available && !run.isPending) run.mutate(trimmed);
  };

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · TOKEN engine" title="Token Scanner" intro="Read one Solana token mint: which token program owns it, decimals, exact supply, and who (if anyone) can still mint or freeze. Read-only. No wallet connection needed." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          These are onchain permissions, not a verdict. An active mint or freeze authority doesn't make a token a scam, and a revoked one doesn't make it safe. No prices, holders, names or scores.
        </p>

        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title="Token Scanner is not available yet">
            <p>{status.data.reason === "tool_not_deployed" ? "The execution service is running, but its Token Scanner update hasn't been deployed yet." : "The execution service isn't connected, so scans can't run."} Nothing is simulated.</p>
          </StatusMessage>
        )}

        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-3" noValidate>
            <label htmlFor="ts-mint" className="label-mono block text-xs text-subtle">Token mint address</label>
            <input
              id="ts-mint" value={mint} onChange={(e) => setMint(e.target.value)} onBlur={() => setTouched(true)}
              maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby="ts-help"
              className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="Base58 mint address"
            />
            <p id="ts-help" className="text-xs text-muted-foreground">
              {touched && trimmed && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : "The mint itself — not a wallet or token account. Mainnet only. Shared limits across all MCPX tools: 6 per minute, 40 per hour."}
            </p>
            <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>
              {run.isPending ? "Scanning…" : "Scan Token"}
            </button>
          </form>
        )}

        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isPending && run.variables && <p className="break-all font-mono text-xs text-muted-foreground">Scanning {run.variables}…</p>}
          {run.isError && (
            <StatusMessage tone="warning" title="Scan failed">
              <p>{ERROR_TEXT[(run.error as ToolError).kind ?? "provider_error"]}</p>
              {(run.error as ToolError).kind === "free_limit" && <FreeLimitNotice />}
              {run.variables && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && !run.isPending && <ResultView r={run.data} />}
        </div>

        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}

const NA = <span className="text-muted-foreground">Unavailable</span>;
const PROGRAM_NAME = { "spl-token": "SPL Token (original)", "token-2022": "Token-2022" } as const;

function Authority({ v }: { v: string | null }) {
  if (v === null) return <span>None — revoked or never set</span>;
  const url = explorerAccountUrl(v);
  return <span className="break-all font-mono text-xs">{v}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</span>;
}

function ResultView({ r }: { r: TokenScannerResult }) {
  const url = explorerAccountUrl(r.mint);
  const notMint: Record<Exclude<TokenScannerResult["status"], "mint">, string> = {
    not_found: "No account exists at this address (at confirmed). It may never have existed or may have been closed.",
    not_token_program: "This account exists but isn't owned by SPL Token or Token-2022, so it isn't a token mint (it may be a wallet or a program).",
    not_a_mint: `This is a ${r.program ? PROGRAM_NAME[r.program] : "token program"} account, but it's a ${r.accountType === "account" ? "token holding account" : (r.accountType ?? "non-mint")} — not a mint.`,
    unparsed: "The provider couldn't decode this token-program account, so nothing is shown.",
  };
  return (
    <section aria-labelledby="ts-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ts-result" className="text-lg font-semibold text-foreground">Result</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <p className="break-all font-mono text-sm text-foreground">{r.mint}{url && <> · <a className="underline" href={url} target="_blank" rel="noreferrer">Solscan</a></>}</p>

      {r.status !== "mint" ? (
        <StatusMessage tone="warning" title="Not a token mint">
          <p>{notMint[r.status]}</p>
          {r.owner && <p className="break-all font-mono text-xs">Owning program: {r.owner}</p>}
        </StatusMessage>
      ) : (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div><dt className="text-subtle">Token program</dt><dd className="text-foreground">{r.program ? PROGRAM_NAME[r.program] : NA}</dd></div>
            <div><dt className="text-subtle">Initialized mint</dt><dd className="text-foreground">{r.isInitialized ? "Yes" : "No"}</dd></div>
            <div><dt className="text-subtle">Decimals</dt><dd className="font-mono text-foreground">{r.decimals}</dd></div>
            <div><dt className="text-subtle">Total supply (onchain)</dt><dd className="break-all font-mono text-foreground">{r.supplyUi}<span className="block text-xs text-muted-foreground">{r.supplyRaw} base units</span></dd></div>
            <div><dt className="text-subtle">Mint authority</dt><dd className="text-foreground"><Authority v={r.mintAuthority} /></dd></div>
            <div><dt className="text-subtle">Freeze authority</dt><dd className="text-foreground"><Authority v={r.freezeAuthority} /></dd></div>
          </dl>
          {r.program === "token-2022" && (
            <div className="text-sm">
              <h3 className="mb-2 font-medium text-foreground">Token-2022 extensions</h3>
              {r.extensions && r.extensions.length > 0 ? (
                <ul className="space-y-2">
                  {r.extensions.map((e, i) => (
                    <li key={i}>
                      <span className="font-mono text-foreground">{e.decoded ? e.name : "Extension details unavailable"}</span>
                      {e.state && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 font-mono text-xs text-muted-foreground">{e.state}</pre>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground">The provider reported no extensions on this mint.</p>}
              {r.extensionsComplete === false && <p className="mt-2 text-xs text-warning">Some extensions couldn't be decoded or weren't all shown, so this list is incomplete.</p>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Supply cross-check: {r.supplyCheck.status === "ok"
              ? (r.supplyCheck.matches ? `getTokenSupply agreed (slot ${r.supplyCheck.slot}).` : `getTokenSupply returned ${r.supplyCheck.supplyRaw} base units at slot ${r.supplyCheck.slot} — different from the account read; supply may have changed between slots.`)
              : "unavailable — only the account read is shown."}
          </p>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Fetched (UTC) {r.fetchedAt}. Account read at slot {r.accountSlot} ({r.commitment}). Source: Solana mainnet via Helius. Observations only — not trading advice.
      </p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}
