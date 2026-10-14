# Launch (src/lib/launch)
- Draft validation is draft.ts (shared browser/server); request parsing drafts-core.ts; persistence drafts.server.ts — one validator so browser and server can't drift.
- Drafts, artifacts and attempts tables are service-role only (RLS on, no policies); every query is scoped by the creator session wallet — the browser never supplies wallet, owner or fees.
- Optimistic concurrency: every change names the revision it edits; any edit or new artwork drops metadata, so stale metadata is never reused.
- Artwork: image.ts is the structural validator (signature, size, 1:1, min/max side per format, no animation; PNG fully inflated with exact size cap + row-filter check), then decode.server.ts fully decodes JPEG with pure-JS jpeg-js (strict, MP + memory caps, so JPEG has a lower max side); WebP is refused because no server decoder exists here — never import .wasm in server code (breaks deploy on this stack); bucket launch-assets is private; public reads go through /api/public/launch-assets/* for recorded artifacts only, with nosniff + sandbox CSP — workspace blocks public buckets and this keeps URLs on mcpx.fun.
- Metadata: metadata.ts is the only serializer; created at review time for one exact revision; objects are immutable random paths, never overwritten or auto-deleted.
- Chain status stays NOT_STARTED (DB CHECK); mcpx_launch_attempts trigger refuses on-chain states without signature/mint/evidence and mint changes — nothing writes attempts until a signing phase is approved.
- Readiness is GET-only getLaunchReadiness (redacted, 30 s cache); on-chain items stay BLOCKED without proof.

- Child launch signing: browser mint key + wallet signTransaction; /api/creator/launch-submit re-runs gateVerify, checks byte-identical message + both Ed25519 sigs, files claim before broadcast; gated by MCPX_CHILD_LAUNCH_SIGNING=1 separately from MCPX_CHILD_LAUNCH_ENABLED — signing can never turn on by enabling preparation.
