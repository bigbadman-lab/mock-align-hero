import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { shortAddress } from "@/lib/wallet/state";
import { transactionVerifierStatusQuery } from "@/lib/tools/status";
import { TV_CLIENT_TIMEOUT_MS, TV_ENDPOINT, isValidSignature, type TransactionVerifierResult } from "@/lib/tools/transaction-verifier";

export const Route = createFileRoute("/tools/transaction-verifier")({
  head: () => ({
    meta: [
      { title: "Transaction Verifier — MCPX" },
      { name: "description", content: "Look up one Solana mainnet transaction signature: confirmation, execution outcome, slot, fee and programs. Read-only." },
      { property: "og:title", content: "Transaction Verifier — MCPX" },
      { property: "og:description", content: "Read-only Solana mainnet transaction lookup with confirmation and execution outcome shown as separate facts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TransactionVerifierPage,
  errorComponent: RouteError,
});

type Kind = "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error" | "unavailable" | "too_large" | "bad_response" | "network" | "unsupported_version" | "free_limit";
const ERROR_TEXT: Record<Kind, string> = {
  invalid_input: "That isn't a valid Solana transaction signature (64 bytes, base58).",
  rate_limited: "Too many lookups right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error.",
  unavailable: "Transaction Verifier is unavailable right now.",
  too_large: "The provider's answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  free_limit: "You've used today's 3 free tests of this tool.",
  unsupported_version: "This transaction uses a version this tool doesn't support yet (legacy and v0 only).",
};
class ToolError extends Error { constructor(public kind: Kind) { super(kind); } }

async function runVerify(signature: string, signal: AbortSignal): Promise<TransactionVerifierResult> {
  let r: Response;
  try {
    r = await fetch(TV_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature }), signal: AbortSignal.any([signal, AbortSignal.timeout(TV_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as { error?: string } | TransactionVerifierResult | null;
  if (!r.ok || !body || "error" in body && typeof (body as { error?: unknown }).error === "string" && !("schema" in body)) {
    const k = (body && "error" in body ? (body as { error?: string }).error : undefined) as Kind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return body as TransactionVerifierResult;
}

const txUrl = (s: string) => `https://solscan.io/tx/${encodeURIComponent(s)}`;

function TransactionVerifierPage() {
  const status = useQuery(transactionVerifierStatusQuery);
  const [sig, setSig] = useState("");
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: (s: string) => { abort.current?.abort(); abort.current = new AbortController(); return runVerify(s, abort.current.signal); },
    retry: false,
  });
  const trimmed = sig.trim();
  const valid = isValidSignature(trimmed);
  const available = status.data?.available === true;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (valid && available && !run.isPending) run.mutate(trimmed);
  };

  return (
    <>
      <PageHeader className="py-6 sm:py-8" label="Template tool · VERIFY engine" title="Transaction Verifier" intro="Look up one Solana mainnet transaction by its signature: whether it was confirmed, whether it executed successfully, and what it touched. Read-only. No wallet connection needed." />
      <PageContainer className="space-y-5 py-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          “Verified” here means the transaction was retrieved from Solana mainnet at the stated confirmation level. It does not mean the transaction is safe, who owns the wallets involved, or that anyone connected here signed it.
        </p>

        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title="Transaction Verifier is not available yet">
            <p>{status.data.reason === "tool_not_deployed" ? "The execution service is running, but its Transaction Verifier update hasn't been deployed yet." : "The execution service isn't connected, so lookups can't run."} Nothing is simulated.</p>
          </StatusMessage>
        )}

        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-3" noValidate>
            <label htmlFor="tv-sig" className="label-mono block text-xs text-subtle">Transaction signature</label>
            <input
              id="tv-sig" value={sig} onChange={(e) => setSig(e.target.value)} onBlur={() => setTouched(true)}
              maxLength={100} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby="tv-help"
              className="w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="Base58 signature"
            />
            <p id="tv-help" className="text-xs text-muted-foreground">
              {touched && trimmed && !valid
                ? <span className="text-warning">Not a valid signature: it must be base58 with no spaces and decode to exactly 64 bytes.</span>
                : <>Mainnet only. Shared limits across all MCPX tools: 6 per minute and 40 per hour per visitor.{valid && <> · <a className="underline" href={txUrl(trimmed)} target="_blank" rel="noreferrer">Open on Solscan</a></>}</>}
            </p>
            <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>
              {run.isPending ? "Verifying…" : "Verify Transaction"}
            </button>
          </form>
        )}

        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isPending && run.variables && <p className="font-mono text-xs text-muted-foreground break-all">Looking up {run.variables}…</p>}
          {run.isError && (
            <StatusMessage tone="warning" title="Lookup failed">
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

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button type="button" className="ml-2 text-xs underline" onClick={() => {
      navigator.clipboard?.writeText(text).then(() => setState("ok"), () => setState("fail"));
      setTimeout(() => setState("idle"), 2000);
    }}>{state === "ok" ? "Copied" : state === "fail" ? "Copy failed — select it by hand" : "Copy"}</button>
  );
}

const NA = <span className="text-muted-foreground">Unavailable</span>;

function ResultView({ r }: { r: TransactionVerifierResult }) {
  return (
    <section aria-labelledby="tv-result" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tv-result" className="text-lg font-semibold text-foreground">Result</h2>
        <span className="label-mono text-xs text-primary">Solana mainnet</span>
      </div>
      <div className="text-sm"><span className="text-subtle">Signature</span>
        <p className="break-all font-mono text-foreground">{r.signature}<CopyButton text={r.signature} /> · <a className="underline" href={txUrl(r.signature)} target="_blank" rel="noreferrer">Solscan</a></p>
      </div>

      {!r.found ? (
        <StatusMessage tone="warning" title="Not found at the checked commitment levels">
          <p>The provider returned no transaction for this signature at {r.commitmentsChecked.join(" or ")}. It may not be confirmed yet, may be outside the provider's stored history, or may never have landed. This is not proof that it doesn't exist.</p>
        </StatusMessage>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusMessage tone="info" title={r.confirmation === "finalized" ? "Finalized" : "Confirmed (not yet finalized)"}>
              <p>Included in slot {r.slot}.</p>
            </StatusMessage>
            <StatusMessage tone={r.execution === "succeeded" ? "info" : "warning"} title={r.execution === "succeeded" ? "Execution succeeded" : r.execution === "failed" ? "Failed execution" : "Execution outcome unavailable"}>
              <p>{r.execution === "failed" ? "The transaction landed onchain but its instructions failed. The fee was still charged." : r.execution === "succeeded" ? "No execution error was recorded." : "The provider returned no execution metadata."}</p>
            </StatusMessage>
          </div>
          {r.error && (
            <div className="text-sm"><p className="text-foreground">{r.error.summary}</p>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-3 font-mono text-xs text-muted-foreground">{r.error.detail}</pre>
              <p className="mt-1 text-xs text-muted-foreground">Raw error as recorded onchain. No cause is inferred.</p>
            </div>
          )}
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Row k="Slot" v={String(r.slot)} />
            <Row k="Block time (UTC)" v={r.blockTime !== null ? new Date(r.blockTime * 1000).toISOString() : null} />
            <Row k="Version" v={r.version === null ? null : r.version === "legacy" ? "legacy" : `v${r.version}`} />
            <Row k="Fee" v={r.feeLamports !== null ? `${r.feeSol} SOL (${r.feeLamports} lamports)` : null} />
            <Row k="Fee payer" v={r.feePayer} mono />
            <Row k="Signers" v={r.signers ? r.signers.join(", ") : null} mono />
            <Row k="Accounts in message" v={r.accountCount !== null ? `${r.accountCount}${r.loadedAddressCount ? ` (${r.loadedAddressCount} from lookup tables)` : ""}` : null} />
            <Row k="Top-level instructions" v={r.topLevelInstructionCount !== null ? String(r.topLevelInstructionCount) : null} />
            <Row k="Compute units consumed" v={r.computeUnitsConsumed !== null ? String(r.computeUnitsConsumed) : null} />
            <Row k="Log messages" v={r.logMessageCount !== null ? `${r.logMessageCount} lines (not shown)` : null} />
          </dl>
          <div className="text-sm">
            <h3 className="mb-2 font-medium text-foreground">Programs called by top-level instructions</h3>
            {r.programIds ? (
              <ul className="space-y-1 font-mono text-xs">{r.programIds.map((p) => <li key={p}><a className="underline" href={`https://solscan.io/account/${encodeURIComponent(p)}`} target="_blank" rel="noreferrer" title={p}>{shortAddress(p)}</a></li>)}</ul>
            ) : NA}
            <p className="mt-2 text-xs text-muted-foreground">Programs reached only through inner instructions (CPIs) are not listed.</p>
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Fetched (UTC) {r.fetchedAt} — this is when MCPX asked, not the block time. Source: {r.source}. Checked: {r.commitmentsChecked.join(", ")}. Supports legacy and v0 transactions. No prices, safety judgement or ownership claims.
      </p>
      <p className="font-mono text-xs text-subtle">Execution {r.executionId}</p>
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: string | null; mono?: boolean }) {
  return <div><dt className="text-subtle">{k}</dt><dd className={`break-all text-foreground ${mono ? "font-mono text-xs" : "font-mono"}`}>{v ?? NA}</dd></div>;
}
