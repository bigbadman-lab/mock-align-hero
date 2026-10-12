import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { verifiedCreationsQuery } from "@/lib/registry";
import { TEMPLATES } from "@/lib/templates";
import { EmptyState, StatusMessage, buttonOutline } from "./primitives";

const COLS = ["Token", "Tool template", "Child mint", "Verified"];
const head = (
  <div role="presentation" className="hidden grid-cols-4 gap-4 border-b border-border bg-surface-2 px-5 py-3 sm:grid">
    {COLS.map((c) => <span key={c} className="label-mono text-subtle">{c}</span>)}
  </div>
);

export function RegistryLoading() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {head}
      <p role="status" className="px-5 py-16 text-center text-sm text-muted-foreground">Checking the verified registry…</p>
    </div>
  );
}

export function VerifiedRegistry() {
  const [page, setPage] = useState(0);
  const q = useQuery(verifiedCreationsQuery(page));

  if (q.isPending) return <RegistryLoading />;
  const r = q.data;
  if (!r || r.status !== "ok") {
    return (
      <StatusMessage tone="warning" title="Registry unavailable">
        <p>{r?.message ?? "The registry could not be reached."} This is not the same as having no listings.</p>
        <button type="button" onClick={() => q.refetch()} disabled={q.isFetching} className={`${buttonOutline} mt-4`}>
          {q.isFetching ? "Retrying…" : "Retry"}
        </button>
      </StatusMessage>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {head}
      {r.items.length === 0 ? (
        <EmptyState title="No verified MCPX child-token listings are available.">
          <p>The registry was checked and holds zero verified creations. $MCP has not been minted yet, and listings will appear only after genuine, verified launches.</p>
          <p className="mt-4">
            <Link to="/docs" hash="tokens" className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary">How token pairing is intended to work</Link>
          </p>
        </EmptyState>
      ) : (
        <ul>
          {r.items.map((c) => (
            <li key={c.id} className="grid gap-1 border-b border-border px-5 py-4 last:border-0 sm:grid-cols-4 sm:gap-4">
              <span className="text-sm text-foreground">{c.display_name} <span className="font-mono text-subtle">${c.ticker}</span></span>
              <span className="text-sm text-muted-foreground">{TEMPLATES.find((t) => t.id === c.template_id)?.name ?? c.template_id}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{c.child_mint}</span>
              <span className="font-mono text-xs text-muted-foreground">{new Date(c.verified_at).toISOString().slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
      {(page > 0 || r.hasMore) && (
        <div className="flex justify-between gap-3 border-t border-border px-5 py-3">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className={buttonOutline}>Previous</button>
          <button type="button" disabled={!r.hasMore} onClick={() => setPage((p) => p + 1)} className={buttonOutline}>Next</button>
        </div>
      )}
    </div>
  );
}
