# MCPX rewards worker (Phase 05-E) — NOT DEPLOYED

Dry-run reward **planner** for native $MCP. No signing, sending, swapping, payouts, mint or ALT code exists in this bundle; it exits (code 2) if `MCPX_REWARDS_MODE` is anything but `DRY_RUN`.

**Render type: Background Worker** (no HTTP). It has no callers and no public endpoint is needed; liveness = process running, readiness = the `ready_state` log line. Kept separate from the six-tool MCP worker, the transaction builder and the website.

Build (Render root = repo root, because it bundles `src/lib/rewards`):
`cd services/rewards-worker && npm ci && npm run build` · Start: `cd services/rewards-worker && npm start`

Environment (names only): `MCPX_REWARDS_MODE` (DRY_RUN), `MCPX_REWARDS_DB_URL`, `MCPX_REWARDS_RPC_URL`, `MCPX_NATIVE_MINT`, `MCPX_NATIVE_DEPLOYER_WALLET` (public address), `MCPX_REWARDS_EMERGENCY_STOP` (1 = no passes), `MCPX_REWARDS_GENESIS_WINDOW`, `MCPX_REWARDS_FINALITY_LAG_SECONDS` (30–3600, default 60), `MCPX_REWARDS_MIN_PAYABLE_LAMPORTS`, `MCPX_REWARDS_POLL_SECONDS` (10–300), `MCPX_REWARDS_MAX_WINDOWS_PER_PASS` (1–288).

Any missing mint/sharing config/treasury/DB/RPC/genesis → stays alive, logs `ready:false` with blockers, makes **no DB writes**.
When configured: lease (DB clock) → one window at a time, bounded per pass → atomic `mcpx_rw_commit_window` (re-derives totals from stored receipts) → HELD plans (holder history unavailable). Exponential backoff to 10 min; SIGTERM stops after the current pass. One instance intended; extras are safe (LEASE_HELD).

Proof harness (throwaway DB only): `test/harness.ts` — see docs/REWARDS_05A.md §05-E for the recorded multi-process run.

05-F replacement: single-deployer model. Sharing-config/treasury envs are no longer read. Future signer secret
`MCPX_NATIVE_DEPLOYER_PRIVATE_KEY` (Render secret only; base58 64-byte or 64-int JSON array) is NOT configured; if present
the worker refuses to start (exit 3) and never logs the value. Rotation = create new Render secret value, redeploy, remove old.
