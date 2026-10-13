# Phase 05-I.1 — Recovery, cutoff efficiency, production preflights (DRY RUN; nothing deployed)

## Inventory (as found)
- Cutoffs: src/lib/rewards/cutoff.ts. Snapshot freezing: cutoff-snapshot.ts / cutoff-snapshot.pg.ts. Supply proof: supply-proof.ts. Policy: eligibility-policy.ts. Worker: services/rewards-worker/src/{main,index-pass,helius-history}.ts.
- Migrations: drizzle/migrations/0000–0009 are applied. 0010 (docs/pending-migrations) is pending. The brief's "rebuild_required" corresponds to the hold reason `CUTOFF_BEHIND_CHECKPOINT_REBUILD_REQUIRED`; the recovery flow works for any open hold.
- Tests before this phase: src/test/rewards-05i.test.ts (14), worker test/assembly.test.ts (7).

## Gate A — recovery (operator-only)
- `services/rewards-worker/scripts/recover-window.ts CANDIDATE <mint> <window> <anchor>`: rebuilds the window read-only from the anchor. It re-selects the cutoff, which must equal the frozen one, then uses the same replay, verification at slot V, supply proof and the frozen record's policy version (src/lib/rewards/recovery.ts, recovery-source.ts).
- Results are stored as immutable, `payable=false` candidates with the original and candidate fingerprints, cutoff, supply, owner differences (up to 200), hold reasons, provenance, operator and correlation ID. Statuses: CANDIDATE_MATCH / CANDIDATE_MISMATCH / CANDIDATE_INCOMPLETE.
- `RESOLVE <id> --confirm` calls the SQL function `mcpx_rw_hix_resolve_window` (service_role only), which works only for a MATCH. It refuses if the open holds changed since the candidate (stale), if the frozen record changed, or if the candidate was already resolved. It runs under a per-window lock. A trigger lets holds be closed only by a recorded decision; they can never be deleted.
- **Mismatches: BLOCKED: POLICY DECISION REQUIRED.** No path replaces or re-pays a frozen snapshot.
- Planning gate: the worker skips any frozen window with an open hold (`windowPayableForPlanning`).
- Real result: both held windows rebuilt to identical fingerprints (~15.9k credits each). One was resolved with --confirm; the other was left held. Frozen rows are unchanged.

## Gate B — cutoff cost
- `selectCutoff` now: memoizes block times within one call, takes its starting point from the previous frozen cutoff (a hint only — every result is re-checked against the chain), and fetches the candidate range with one getBlocks call. The guard band, finality and hold rules are unchanged. `selectCutoffBaseline` keeps the old algorithm for comparison.
- Equivalence: identical results on 6 real mainnet windows (including the two 05-I windows) and on every fixture case: skips, equal timestamps, clock going backwards, missing timestamps, invalid/future/far hints, window gaps, retry, finality.
- Cost (RPC calls; credits **estimated** at 1 per call): baseline 47 → optimized 30–31 per recent window with a hint. That is ~406k → ~268k per month (estimate). The 14 guard-band timestamp reads remain on purpose.

## Tests
- `bunx vitest run`: 30 files passed, 1 skipped; 271 tests passed, 11 skipped. DB tests are skipped unless MCPX_TEST_PG_URL is set.
- `MCPX_TEST_PG_URL=<local> bunx vitest run src/test/rewards-05i1-db.test.ts`: 24/24 passed (pure + real Postgres).
- `npx tsgo --noEmit`: clean. Worker: `bun test` 7/7, `npm run build` OK (135 KB, 0 sign/send symbols, 0 key-like strings).

## Limitations / next
- On a very active coin, a recovery rebuild may need several rounds. It fails closed as INCOMPLETE after 6 rounds.
- Mismatch remediation requires a business decision.
- Production migration and Render deployment require separate approvals (see the two preflight docs).
- Six tools, MCP demo and launch flow: NOT RE-TESTED live. No code there changed, and their existing unit tests pass.
