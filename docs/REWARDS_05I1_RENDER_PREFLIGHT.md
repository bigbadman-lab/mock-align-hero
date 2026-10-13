# Rewards worker — Render dry-run preflight (DOCUMENTATION ONLY; no service created)

## Process
- Render **Background Worker**, no port. Root `services/rewards-worker`, Node ≥ 20. Build: `npm ci && npm run build`. Start: `npm start`.
- 1 instance, smallest plan. Memory is dominated by holder-index state (~MBs for thousands of accounts).
- Loop: every `MCPX_REWARDS_POLL_SECONDS` (default 300, clamped to 60–900). Each pass selects cutoffs, runs one index pass, then dry-run planning. Errors back off exponentially up to 10 minutes. SIGTERM triggers a graceful stop.

## Environment (names only)
- Required: MCPX_REWARDS_MODE=DRY_RUN, MCPX_REWARDS_DB_URL, MCPX_REWARDS_RPC_URL, MCPX_NATIVE_MINT, MCPX_NATIVE_DEPLOYER_WALLET (public address), MCPX_NATIVE_ANCHOR_SLOT, MCPX_REWARDS_GENESIS_WINDOW (multiple of 300).
- Optional: MCPX_REWARDS_POLL_SECONDS (300), MCPX_REWARDS_MAX_WINDOWS_PER_PASS (12), MCPX_REWARDS_FINALITY_LAG_SECONDS (60), MCPX_REWARDS_MIN_PAYABLE_LAMPORTS (0), MCPX_REWARDS_EMERGENCY_STOP (unset; "1" = idle).
- Must NOT be set: MCPX_NATIVE_DEPLOYER_PRIVATE_KEY.
- The recovery CLI is not part of the worker. It uses MCPX_RECOVERY_DB_URL and MCPX_OPERATOR_ID and runs only from an operator machine.

## Verified locally (this session)
- `MCPX_REWARDS_MODE=LIVE` → exit 2 `refused_mode`.
- Private key present → exit 3 `refused_signer_secret`; the value is never logged.
- Emergency stop → stays idle (`ready_state` with EMERGENCY_STOP).
- No configuration → health true, ready false, no database writes.
- Bundle dist/worker.mjs is 135 KB: 0 matches for sendTransaction/signTransaction/sendRawTransaction/fromSecretKey, 0 key-like strings. The recovery CLI is not bundled.
- Clean `npm ci` + build + `bun test` (7/7) pass.

## Isolation and privileges
- RPC: read-only methods only (getSlot, getBlocks, getBlockTime, getTransactionsForAddress, getTransaction, getMultipleAccounts).
- Database: needs the service role (RLS-locked tables). There is no dedicated least-privilege database role yet (OPEN).
- Separate from the website, the six-tool MCP worker and the transaction builder; none of them import it.

## Concurrency
- Index writes use a compare-and-swap on the checkpoint, so a second replica gets STALE. Frozen-row uniqueness and fingerprint comparison prevent double records. The planner holds a single database lease (05-E).
- A second replica wastes RPC credits but cannot double-process. Keep 1 instance.

## Monitoring
- JSON logs carry svc, correlationId and events: ready_state, diagnostics (latest cutoff, index slot, holder accounts, open gaps and holds, credits per pass and total, policy status, pipeline status), pass, pass_failed.
- Alert on: pass_failed repeating, openHolds > 0, openGaps > 0, passCredits above budget, and a status without DRY_RUN_READY for more than 1 hour.
- Kill switch: MCPX_REWARDS_EMERGENCY_STOP=1, or suspend the service.

## Cost guardrails
- Measured: ~6–25 credits per steady pass and ~30 per cutoff after optimisation (estimate basis: 1 credit per call). A full rebuild costs ~15.9k.
- OPEN: no hard per-day credit cap in code yet. Recommended before deploy.

## Operator steps (hold points marked STOP)
1. STOP: production migrations 0010 + 0011 approved and applied.
2. Create the Background Worker (branch main, auto-deploy OFF, 1 instance) with the env above. STOP: values reviewed by a second person.
3. Deploy, then confirm `started` and the first `diagnostics` show FINANCIAL_EXECUTION_DISABLED and DRY_RUN.
4. Watch for 24 h. Rollback = suspend the service; database data is retained and the website is unaffected.
