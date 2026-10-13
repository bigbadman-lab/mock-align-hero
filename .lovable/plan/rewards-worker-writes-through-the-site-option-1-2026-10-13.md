# Rewards worker writes through the site (Option 1)

## Goal
The Render rewards worker runs with no database login. It sends its results to private site addresses that check a shared seal (HMAC) before saving. Setting the $MCP mint becomes the only step needed for rewards planning to start on real data.

## What gets built

1. **Private site addresses** (`/api/public/rewards/*`, seal-checked, refuse everything else)
   - `lease` — take or renew the single worker lease (only one worker runs at a time)
   - `state` — read the checkpoint, watermark and frozen-window info the worker needs to resume
   - `holder-batch` — record holder-history pages and account balances
   - `snapshot` — freeze a window cutoff + supply proof (one transaction, existing `mcpx_rw_*` SQL functions)
   - `commit-window` — commit a window plan through the existing `mcpx_rw_commit_window`
   - `heartbeat` — run log / health
   Each request: HMAC-SHA256 over method + path + timestamp + nonce + body hash; rejected if older than 5 minutes or nonce reused; body validated with strict size limits. The site does all writes with server-only access; the database re-checks totals as it does today.

2. **Worker change** — replace the Postgres store in `services/rewards-worker` with an HTTP store that calls these addresses. `MCPX_REWARDS_DB_URL` is removed; new Render variables: `MCPX_SITE_URL`, `MCPX_REWARDS_SHARED_SECRET`.

3. **Mint as the single go-live input** — the worker reads the mint, deployer wallet, anchor slot and genesis window from the site (`state`), not from Render variables. When the mint is set in the system, the next worker pass starts indexing — no Render changes, no mode switch.

4. **Secret** — one shared secret, created in the website's secrets and pasted once into Render (secure form with a Generate button).

5. **Tests** — seal accepted/rejected (wrong secret, altered body, old timestamp, replayed nonce), lease exclusivity, conservation still enforced, worker store contract parity with the existing Postgres store tests.

6. **Migration** — one small migration for the request-nonce table and a mint/config row (service-role only). Applied only with your approval.

## Decision needed: payouts
Today the system plans rewards but never sends money — the worker refuses to start if a private key is present. "Treated as officially live" on mint can mean:
- **A. Live planning, payouts approved separately** — on mint, real holder snapshots and payout amounts are computed and shown automatically; sending SOL is built in a later phase. Fits this plan.
- **B. Fully automatic payouts** — also requires the deployer wallet's private key on Render and a payout-sending phase (signing, retries, double-pay protection). That's a separate, larger brief and a big security decision.

This plan builds A now and leaves the payout step designed so B plugs in without touching the mint flow.

## Not changed
Tools, launch flow, AI keys, fee split, 3/day free tests.
