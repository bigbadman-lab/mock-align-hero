// Shared website-execution framework for launched products: request, errors, result container.
// Template-specific forms/renderers plug in via ProductToolInterface (index.tsx).
import { useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { StatusMessage } from "@/components/mcpx/primitives";
import { CopyButton } from "@/components/mcpx/McpConnection";

export const RUN_TIMEOUT_MS = 30_000;
export type RunErrorKind =
  | "invalid_input" | "rate_limited" | "free_limit" | "busy" | "timeout" | "provider_error" | "unavailable"
  | "too_large" | "bad_response" | "network" | "not_found" | "not_runnable" | "product_inactive";

export const RUN_ERROR_TEXT: Record<RunErrorKind, string> = {
  invalid_input: "That input isn't valid for this tool.",
  rate_limited: "Too many requests right now. Wait a minute, then try again.",
  free_limit: "You've used today's 3 free website runs of this tool.",
  busy: "The tool is busy. Try again in a moment.",
  timeout: "The data provider didn't answer in time.",
  provider_error: "The Solana data provider returned an error.",
  unavailable: "The tool is unavailable right now.",
  too_large: "The answer was larger than this tool can safely handle.",
  bad_response: "The data provider returned something we couldn't verify, so nothing is shown.",
  network: "Couldn't reach MCPX. Check your connection.",
  not_found: "This product couldn't be found.",
  not_runnable: "This product doesn't have a website interface yet. Use it via MCP.",
  product_inactive: "This product isn't active, so it can't run.",
};
const RETRYABLE: RunErrorKind[] = ["rate_limited", "busy", "timeout", "provider_error", "unavailable", "network", "bad_response", "too_large"];

export class RunError extends Error { constructor(public kind: RunErrorKind) { super(kind); } }

export async function postRun<T>(slug: string, input: Record<string, string>, signal: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api/products/${encodeURIComponent(slug)}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
    });
  } catch { throw new RunError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!r.ok || !body || !("schema" in body)) {
    const k = body?.["error"] as RunErrorKind | undefined;
    throw new RunError(k && k in RUN_ERROR_TEXT ? k : "provider_error");
  }
  return body as T;
}

/** One pending execution at a time; a new run aborts the previous request. */
export function useProductRun<T>(slug: string) {
  const abort = useRef<AbortController | null>(null);
  return useMutation({
    mutationFn: (input: Record<string, string>) => {
      abort.current?.abort(); abort.current = new AbortController();
      return postRun<T>(slug, input, abort.current.signal);
    },
    retry: false,
  });
}

export function RunErrorView({ error, onRetry, disabled }: { error: unknown; onRetry?: () => void; disabled?: boolean }) {
  const kind = error instanceof RunError ? error.kind : "provider_error";
  return (
    <StatusMessage tone="warning" title={kind === "free_limit" ? "Daily limit reached" : "Run failed"}>
      <p role="alert">{RUN_ERROR_TEXT[kind]}</p>
      {kind === "free_limit" && <p className="mt-1">Free runs reset at midnight UTC. You can keep using this tool from your own MCP client with a product key.</p>}
      {onRetry && RETRYABLE.includes(kind) && (
        <button type="button" className="mt-2 underline underline-offset-4" onClick={onRetry} disabled={disabled}>Retry</button>
      )}
    </StatusMessage>
  );
}

export function ResultFrame({ title, meta, raw, children }: { title: string; meta?: ReactNode; raw: unknown; children: ReactNode }) {
  const text = JSON.stringify(raw, null, 2);
  return (
    <section aria-labelledby="run-result-h" className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="run-result-h" className="text-base font-semibold text-foreground">{title}</h3>
        <CopyButton text={text} label="Copy results" />
      </div>
      {children}
      {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
      <details className="rounded-md border border-border bg-surface-2">
        <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-subtle">Raw JSON</summary>
        <pre className="max-h-96 overflow-auto border-t border-border p-3 font-mono text-xs text-foreground">{text}</pre>
      </details>
    </section>
  );
}

export function ResultBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <h4 className="label-mono mb-2 text-xs text-subtle">{title}</h4>
      {children}
    </div>
  );
}

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-border py-1.5 text-sm last:border-0 sm:grid-cols-[9rem_1fr]">
      <dt className="text-subtle">{k}</dt>
      <dd className="min-w-0 break-all text-foreground">{children}</dd>
    </div>
  );
}
