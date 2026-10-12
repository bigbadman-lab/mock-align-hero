# MCPX MCP-execution worker

Separate service for Render. Read-only Solana mainnet queries. No database, no signing keys, no wallet writes.

## Endpoints
- `GET /health` — process is alive.
- `GET /ready` — 200 only when `HELIUS_RPC_URL` (https) and `MCPX_WORKER_SECRET` (32+ chars) are set. Never returns their values.
- `POST /internal/v1/tools/execute` — HMAC-SHA256 signed by the MCPX website. Accepts only
  `{"schema":"mcpx.tool-execution.wallet-inspector.v1","toolId":"wallet_inspector","input":{"address":"<base58>"}}`.
  Headers: `x-mcpx-timestamp` (ms, ±60s), `x-mcpx-nonce` (uuid, single-use), `x-mcpx-signature` = hex HMAC of `${timestamp}.${nonce}.${body}`.

## Limits
Body ≤ 2 KB · max 8 concurrent · max 60 executions/min for the whole worker · 8 s per RPC call · 20 s per request ·
max 500 token accounts per token program · RPC responses ≤ 2 MB. Commitment: `confirmed`. No retries.
The worker keeps limits in memory, so run exactly **one instance**.

## Deploy on Render (operator)
1. New → Web Service → connect the repo. Root directory: `services/mcp-worker`.
2. Runtime Node. Build: `npm install`. Start: `npm start`. Instances: 1. Health check path: `/health`.
3. Environment variables:
   - `HELIUS_RPC_URL` — your Helius **mainnet** RPC URL including your API key.
   - `MCPX_WORKER_SECRET` — the exact same value saved in the website's `MCPX_WORKER_SECRET` secret.
4. Deploy, then open `https://<your-service>.onrender.com/ready` — it must show `"ready":true`.
5. Give the service base URL (no path) to Lovable to save as the website secret `MCPX_WORKER_URL`.
6. In Helius, set a monthly credit cap / alerts for this key (provider budget cutoff).

## Transaction Verifier (Phase 02-B)
Tool `transaction_verifier`, schema `mcpx.tool-execution.transaction-verifier.v1`, input `{"signature":"<base58, 64 bytes>"}`.
Reads `getTransaction` (jsonParsed, maxSupportedTransactionVersion 0) at `finalized`, and only if that returns null, once more at `confirmed`. Max 2 RPC reads per run; shares the worker's 8-concurrent / 60-per-minute limits with Wallet Inspector. `/ready` now lists `tools`; the website only enables a tool listed there.
Redeploy: Render → existing service → Manual Deploy → Deploy latest commit (keep 1 instance; no new env vars).
