# CANVAS-01 — Template 11: Guided capability composition (smallest honest slice)

## Goal
Add Canvas as the eleventh Tool Library option. A creator builds Canvas only inside the existing combined token + tool launch draft, as an ordered pipeline (2–4 steps) of the existing tools' real capabilities. Nothing launches, signs or goes live; child launching stays off.

## What creators can genuinely do after this gate
- Pick Canvas in the Library or launch form, choose 2–4 steps from tools that actually run on the worker, order them, and connect step outputs to later inputs only through approved mappings.
- Get instant, plain-language compatibility errors (e.g. "Supply Monitor needs a token address; Wallet Inspector does not output one").
- Save Canvas with the same launch draft (same sign-in, same revision checks, same 60/25/15, creator = signed-in wallet).
- Run a real dry run of the pipeline against the live worker, using the shared free-test budget, clearly labelled "Dry run — not a live product".
- Optional AI summary step only if the creator has a working OpenAI key in the existing BYOK settings; otherwise shown as unavailable.
- The existing "Check launch transaction (no signing)" also validates the Canvas configuration.

## Explicitly not in this gate
No standalone Canvas launch or endpoint, no live MCP endpoint (none until a confirmed child launch), no arbitrary URLs/code/branching/loops, no new providers beyond existing OpenAI BYOK, no dashboard usage figures (none exist yet — shown as empty, not invented), no publish/deploy, no mint/sign/spend, no Render changes.

## Steps
1. **Audit** — confirm per-tool which worker operations are live and their exact input/output shapes; record any library tile without a real handler as unavailable in the report.
2. **Capability catalog** (server-owned, versioned) — one entry per live capability: inputs, outputs, limits, cost bucket; plus a fixed compatibility table of allowed output→input mappings (e.g. token mint → token address, wallet owner → wallet address). Browser only references IDs.
3. **Validator** — pure, shared browser/server: step count, no repeats/cycles, every required input satisfied by user input or an allowed mapping, versions match catalog. Server re-validates on save and before any check.
4. **Library + launch form** — Canvas card (11th) in the same visual style; guided Canvas section inside the launch draft with step picker, reordering (keyboard-accessible), mapping selectors, validation panel, mobile layout.
5. **Storage** — additive migration (draft Canvas config with revision, versioned published-config table for later, audit events; server-only, creator-scoped). Tested on a disposable database first. **Production application needs your separate approval.**
6. **Dry-run execution** — one server route that runs the validated pipeline step by step through the existing relay (shared rate limits, signed worker calls), strict step/time/output caps, trace ID, only mapped fields passed forward, no secrets in logs.
7. **Dashboard** — read-only Canvas panel for saved drafts (steps, revision, validation state); version history/rollback structure exists but stays inactive until a product is genuinely launched.
8. **Launch-confirmation hook** — idempotent function that links Canvas config to the registry product only on chain-confirmed launch; unit-tested for retries and uncertain confirmation, not reachable while launching is off.
9. **Tests + report** — catalog/validator, draft integrity, cycle/repeat/forged-capability refusal, dry-run trace against the real worker, migration tests; then the PASS/PARTIAL/BLOCKED report. Stop before publishing.

## Technical details
- New: `src/lib/canvas/{catalog.ts, validate.ts, run.server.ts}`, `src/components/mcpx/launch/CanvasBuilder.tsx`, `src/routes/api/creator/canvas-dry-run.ts`, `docs/pending-migrations/0022_mcpx_canvas.sql`, tests in `src/test/canvas/*`.
- Touched: `src/lib/templates.ts` (LIBRARY entry 11, `planned:false`, `mcpAdapter:false` until a real gateway adapter is added), `src/lib/launch/draft.ts` + `drafts-core.ts` (optional `canvas` field), `drafts.server.ts`, `LaunchTxCheck`, launch route, dashboard.
- Reuses `src/lib/tools/relay.ts` buckets (no capacity multiplication), BYOK `execute.ts` for the optional AI step, creator SIWS session for every write.
- No changes to the three Render services, rewards or child-fee code.
