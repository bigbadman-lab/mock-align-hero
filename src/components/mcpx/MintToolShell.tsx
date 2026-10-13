// Shared form + status + error shell for single-mint tools (Holder Intelligence, Token Risk Analyst).
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { FreeLimitNotice } from "@/components/mcpx/FreeLimitNotice";
import { PageContainer, PageHeader, StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import type { holderIntelligenceStatusQuery } from "@/lib/tools/status";

export type Kind = "invalid_input" | "rate_limited" | "busy" | "timeout" | "provider_error" | "unavailable" | "too_large" | "bad_response" | "network" | "free_limit";
export const ERROR_TEXT: Record<Kind, string> = {
  invalid_input: "That isn't a valid Solana public address.",
  rate_limited: "Too many requests right now. Wait a minute, then try again.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error, so nothing is shown.",
  unavailable: "This tool is unavailable right now.",
  too_large: "The provider's answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  free_limit: "You've used today's 3 free tests of this tool.",
};
export class ToolError extends Error { constructor(public kind: Kind) { super(kind); } }

/** POST a JSON body to a same-origin tool relay; maps failures to stable, user-facing error kinds. */
export async function postTool<R>(endpoint: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<R> {
  let r: Response;
  try {
    r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
  const b = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !b || !("schema" in b)) {
    const k = b?.["error"] as Kind | undefined;
    throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
  }
  return b as R;
}

/** Availability banner + error box shared by every single-request tool page. */
export function ToolStatusBanner({ name, status }: { name: string; status: ReturnType<typeof useQuery<import("@/lib/tools/status").ToolStatus>> }) {
  if (status.isPending) return <StatusMessage title="Checking tool availability…" />;
  if (status.isError) return <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>;
  if (status.data && !status.data.available) return (
    <StatusMessage tone="warning" title={`${name} is not available yet`}>
      <p>{status.data.reason === "tool_not_deployed" ? `The execution service is running, but its ${name} update hasn't been deployed yet.` : "The execution service isn't connected, so checks can't run."} Nothing is simulated.</p>
    </StatusMessage>
  );
  return null;
}
export function ToolErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as ToolError;
  return (
    <StatusMessage tone="warning" title={e.kind === "free_limit" ? "Free tests used" : e.kind === "rate_limited" ? "Rate limited" : "Check failed"}>
      <p>{ERROR_TEXT[e.kind ?? "provider_error"]}</p>
      {e.kind === "free_limit" && <FreeLimitNotice />}
      {onRetry && e.kind !== "free_limit" && <button className="mt-2 underline" onClick={onRetry}>Retry</button>}
    </StatusMessage>
  );
}
export const QUOTA_HELP = "Mainnet only. 3 free tests per day (resets 00:00 UTC). Shared limits across all MCPX tools: 6 per minute, 40 per hour.";

export const PROGRAM_NAME = { "spl-token": "SPL Token (original)", "token-2022": "Token-2022" } as const;
export const NOT_MINT: Record<string, string> = {
  not_found: "No account exists at this address (at confirmed).",
  not_token_program: "This account isn't owned by SPL Token or Token-2022, so it isn't a token mint.",
  not_a_mint: "This is a token-program account, but not a mint (it may be a token holding account).",
  unparsed: "The provider couldn't decode this token-program account, so nothing is shown.",
};

export function MintToolShell<R>({ id, name, label, intro, note, buttonText, endpoint, timeoutMs, statusQuery, render }: {
  id: string; name: string; label: string; intro: string; note: ReactNode; buttonText: string; endpoint: string; timeoutMs: number;
  statusQuery: typeof holderIntelligenceStatusQuery; render: (r: R) => ReactNode;
}) {
  const status = useQuery(statusQuery);
  const [mint, setMint] = useState("");
  const [touched, setTouched] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: async (m: string): Promise<R> => {
      abort.current?.abort(); abort.current = new AbortController();
      const signal = abort.current.signal;
      let r: Response;
      try {
        r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint: m }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      } catch { throw new ToolError(signal.aborted ? "network" : "timeout"); }
      const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (!r.ok || !body || !("schema" in body)) {
        const k = body?.["error"] as Kind | undefined;
        throw new ToolError(k && k in ERROR_TEXT ? k : "provider_error");
      }
      return body as R;
    },
    retry: false,
  });
  const trimmed = mint.trim();
  const valid = isValidSolanaAddress(trimmed);
  const available = status.data?.available === true;
  const err = run.error as ToolError | null;
  const submit = (e: React.FormEvent) => { e.preventDefault(); setTouched(true); if (valid && available && !run.isPending) run.mutate(trimmed); };

  return (
    <>
      <PageHeader label={label} title={name} intro={intro} />
      <PageContainer className="space-y-10 py-12">
        <div className="max-w-2xl text-sm text-muted-foreground">{note}</div>
        {status.isPending && <StatusMessage title="Checking tool availability…" />}
        {status.isError && <StatusMessage tone="warning" title="Couldn't check availability"><button className="underline" onClick={() => void status.refetch()}>Check again</button></StatusMessage>}
        {status.data && !available && (
          <StatusMessage tone="warning" title={`${name} is not available yet`}>
            <p>{status.data.reason === "tool_not_deployed" ? `The execution service is running, but its ${name} update hasn't been deployed yet.` : "The execution service isn't connected, so checks can't run."} Nothing is simulated.</p>
          </StatusMessage>
        )}
        {available && (
          <form onSubmit={submit} className="max-w-2xl space-y-3" noValidate>
            <label htmlFor={`${id}-mint`} className="label-mono block text-xs text-subtle">Token mint address</label>
            <input
              id={`${id}-mint`} value={mint} onChange={(e) => setMint(e.target.value)} onBlur={() => setTouched(true)}
              maxLength={60} autoComplete="off" spellCheck={false} aria-invalid={touched && !!trimmed && !valid} aria-describedby={`${id}-help`}
              className="w-full rounded-md border border-border-strong bg-surface-2 px-4 py-3 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="Base58 mint address"
            />
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              {touched && trimmed && !valid ? <span className="text-warning">Not a valid 32-byte Solana public key.</span> : "Mainnet only. 3 free tests per day (resets 00:00 UTC). Shared limits across all MCPX tools: 6 per minute, 40 per hour."}
            </p>
            <button type="submit" className={buttonPrimary} disabled={!valid || run.isPending} aria-disabled={!valid || run.isPending}>{run.isPending ? "Checking…" : buttonText}</button>
          </form>
        )}
        <div aria-live="polite" aria-busy={run.isPending}>
          {run.isPending && run.variables && <p className="break-all font-mono text-xs text-muted-foreground">Checking {run.variables}…</p>}
          {err && (
            <StatusMessage tone="warning" title={err.kind === "free_limit" ? "Free tests used" : err.kind === "rate_limited" ? "Rate limited" : "Check failed"}>
              <p>{ERROR_TEXT[err.kind ?? "provider_error"]}</p>
              {err.kind === "free_limit" && <FreeLimitNotice />}
              {run.variables && err.kind !== "free_limit" && <button className="mt-2 underline" onClick={() => run.mutate(run.variables!)} disabled={run.isPending}>Retry</button>}
            </StatusMessage>
          )}
          {run.data && !run.isPending && render(run.data)}
        </div>
        <p className="text-sm text-muted-foreground"><Link to="/mcp" className="underline underline-offset-4">Back to templates</Link></p>
      </PageContainer>
    </>
  );
}
