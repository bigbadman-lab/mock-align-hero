# Launch (src/lib/launch)
- Draft validation is draft.ts (shared browser/server); request parsing drafts-core.ts; persistence drafts.server.ts — one validator so browser and server can't drift.
- Drafts, artifacts and attempts tables are service-role only (RLS on, no policies); every query is scoped by the creator session wallet — the browser never supplies wallet, owner or fees.
- Optimistic concurrency: every change names the revision it edits; any edit or new artwork drops metadata, so stale metadata is never reused.
- Artwork: image.ts is the only validator (signature + structure, PNG fully inflated with exact size cap); bucket launch-assets is private; public reads go through /api/public/launch-assets/* for recorded artifacts only, with nosniff + sandbox CSP — workspace blocks public buckets and this keeps URLs on mcpx.fun.
- Metadata: metadata.ts is the only serializer; created at review time for one exact revision; objects are immutable random paths, never overwritten or auto-deleted.
- Chain status stays NOT_STARTED (DB CHECK); mcpx_launch_attempts trigger refuses on-chain states without signature/mint/evidence and mint changes — nothing writes attempts until a signing phase is approved.
- Readiness is GET-only getLaunchReadiness (redacted, 30 s cache); on-chain items stay BLOCKED without proof.
