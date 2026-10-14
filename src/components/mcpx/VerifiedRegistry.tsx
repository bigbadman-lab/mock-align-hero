import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { verifiedCreationsQuery } from "@/lib/registry";
import { TEMPLATES } from "@/lib/templates";
import { tokenMarketQuery } from "@/lib/token-market.functions";
import { formatUsd } from "@/lib/treasury/core";
import { EmptyState, StatusMessage, buttonOutline } from "./primitives";

const COLS = ["Token", "Tool template", "Child mint", "FDV", "Verified"];
const GRID = "sm:grid-cols-[1.3fr_1fr_1.4fr_0.7fr_0.7fr]";
const head = (
  <div role="presentation" className={`hidden gap-3 border-b border-border bg-surface-2 px-4 py-2 sm:grid ${GRID}`}>
    {COLS.map((c) => <span key={c} className="label-mono text-subtle">{c}</span>)}
  </div>
);

export function RegistryLoading() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {head}
      <p role="status" aria-busy="true" className="px-4 py-8 text-center text-sm text-muted-foreground">Checking the verified registry…</p>
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
        <p role="alert">{r?.message ?? "The registry could not be reached."} This is not the same as having no listings.</p>
        <button type="button" onClick={() => { if (!q.isFetching) void q.refetch({ cancelRefetch: false }); }} disabled={q.isFetching} aria-busy={q.isFetching} className={`${buttonOutline} mt-4`}>
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
            <li key={c.id} className={`grid items-center gap-1 border-b border-border px-4 py-2 last:border-0 sm:gap-3 ${GRID}`}>
              <Link to="/mcp/$slug" params={{ slug: c.slug }} className="text-sm text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary">{c.display_name} <span className="font-mono text-subtle">${c.ticker}</span></Link>
              <span className="text-sm text-muted-foreground">{TEMPLATES.find((t) => t.id === c.template_id)?.name ?? c.template_id}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{c.child_mint}</span>
              <Fdv slug={c.slug} />
              <span className="font-mono text-xs text-muted-foreground">{new Date(c.verified_at).toISOString().slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
      {(page > 0 || r.hasMore) && (
        <div className="flex justify-between gap-3 border-t border-border px-4 py-2">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className={buttonOutline}>Previous</button>
          <button type="button" disabled={!r.hasMore} onClick={() => setPage((p) => p + 1)} className={buttonOutline}>Next</button>
        </div>
      )}
    </div>
  );
}

// FDV per row via the slug-resolved, server-cached market read (refreshes every 30s; unknown shows "—", never 0).
function Fdv({ slug }: { slug: string }) {
  const { data } = useQuery(tokenMarketQuery(slug));
  const v = data?.status === "ok" ? data.market?.fdvUsd ?? null : null;
  return <span className="font-mono text-xs text-foreground"><span className="text-subtle sm:hidden">FDV </span>{v != null ? formatUsd(v) : "—"}</span>;
}
