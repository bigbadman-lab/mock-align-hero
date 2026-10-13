# Phase 05-I — Finalized cutoff snapshots & worker readiness (DRY RUN, not deployed)

## Cutoff rule (CUTOFF_RULE_V1) — src/lib/rewards/cutoff.ts
Window [start, start+300). A tx counts toward a window's holdings only if its block's blockTime < end. A slot is included or left out as a whole, so transactions in the same slot can never fall on both sides of the boundary.
cutoffSlot = the last produced finalized slot with blockTime < end, where the next produced slot has blockTime ≥ end. Skipped slots are recorded. Six guard blocks on each side must have block times that are not null, never go backwards, and fall on the correct side of `end`. The finalized head must be at least 20 s past `end`. Otherwise the window goes to HOLD (NOT_FINAL_YET / RPC_UNKNOWN / BLOCK_TIME_MISSING / NON_MONOTONIC_BLOCK_TIME) and is retried. A saved SELECTED cutoff never changes.

## Snapshot at cutoff — services/rewards-worker/src/index-pass.ts
1. Select cutoffs first. The index refuses to move past the end of any window whose cutoff has not been selected yet (AWAITING_CUTOFF_SELECTION).
2. Fetch the mint's full history up to a fixed slot V. Run the per-account sweep (on a from-scratch rebuild, or for any mismatched account).
3. Replay transactions in (slot, txIndex) order and take a copy of the state at each cutoff. Two different transactions at the same position → gap.
4. Check every touched account and the mint itself at one finalized slot. Any mismatch → gap, and nothing is frozen.
5. Supply at cutoff = mint supply at V − the MintTo/Burn amounts decoded from the mint's own token-program instructions in (cutoff, V] (src/lib/rewards/supply-proof.ts). An unrecognised instruction → UNPROVEN → hold. This supply must equal the replayed total.
6. Freeze the snapshot and advance the checkpoint in one transaction, guarded by compare-and-swap. A losing writer gets STALE.
Frozen data is immutable (triggers). If a gap reaches back before a frozen cutoff, a LATE_PRE_CUTOFF_DATA hold opens and nothing is rewritten. A cutoff already behind the checkpoint gets CUTOFF_BEHIND_CHECKPOINT_REBUILD_REQUIRED.

## Eligibility policy v1 — src/lib/rewards/eligibility-policy.ts
No minimum balance. Excluded: deployer, burn, identified pool vaults, MCPX holdings. PDA, delegated, frozen or unknown owners → AMBIGUOUS → hold. Statuses: DRAFT / TEST_FIXTURE (version `test-*`, never live) / APPROVED_FOR_LIVE_PAYOUTS. Approval requires the mint, deployer, verified pools and an approver. If no holder is eligible, the budget carries forward.

## Schema
docs/pending-migrations/0010_mcpx_05i_cutoff_snapshots.sql — **NOT applied to production**. It needs approval. The worker reports SCHEMA_0010_NOT_APPLIED and freezes nothing until it is applied.

## Future Render Background Worker recipe (do not create yet)
- Repo: this repo, branch main, root `services/rewards-worker`; Background Worker (no port); 1 instance; auto-deploy OFF.
- Build: `npm ci && npm run build`. Start: `npm start` (node dist/worker.mjs). Node ≥ 20.
- Env names only: MCPX_REWARDS_MODE=DRY_RUN, MCPX_REWARDS_DB_URL, MCPX_REWARDS_RPC_URL (existing Helius Developer endpoint), MCPX_NATIVE_MINT, MCPX_NATIVE_DEPLOYER_WALLET, MCPX_NATIVE_ANCHOR_SLOT, MCPX_REWARDS_GENESIS_WINDOW, MCPX_REWARDS_POLL_SECONDS (default 300), MCPX_REWARDS_MAX_WINDOWS_PER_PASS, MCPX_REWARDS_EMERGENCY_STOP. Never set MCPX_NATIVE_DEPLOYER_PRIVATE_KEY (the worker refuses to start, exit 3).
- Verify: the logs show `ready_state`/`diagnostics` with status containing FINANCIAL_EXECUTION_DISABLED; any mode other than DRY_RUN exits 2.
- Rollback: suspend the service. The website and the two existing Render services do not depend on it.

## Evidence
docs/evidence/05i-cutoff-snapshots.json (real Helius data, throwaway local Postgres).
