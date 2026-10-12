# MCPX transaction builder (Phase 04-A)

Separate Render Web Service. Builds **unsigned** Pump.fun launch candidates with the official SDK and
reports evidence. It never signs, submits, broadcasts, holds keys or spends. It is NOT the MCP worker
(`services/mcp-worker`) and shares no secret, deploy config or instance with it.

## Render setup (manual — operator only)
- New Web Service, same repo. **Root directory:** `services/transaction-builder`
- **Build:** `npm ci` — **Start:** `npm start` — Node ≥ 20
- **Instances: exactly 1.** Request-nonce replay protection and prepare idempotency are in memory;
  more than one instance (or autoscaling) would let a replayed request hit a second instance.
- **Health check path:** `/health`. Readiness probe: `GET /ready`.

### Environment
| Name | Required | Notes |
|---|---|---|
| `MCPX_TX_BUILDER_SECRET` | yes | ≥32 chars, **different** from the MCP worker secret |
| `SOLANA_RPC_URL` | yes | https; read-only use (account reads, latest blockhash) |
| `MCPX_FEE_OPS_RECIPIENT` | yes | 25% child operations public key |
| `MCPX_FEE_PLATFORM_RECIPIENT` | yes | 15% platform public key (distinct) |
| `MCPX_QUOTE_MINT` | no | canonical `$MCP` mint — unset until it exists ⇒ `QUOTE_MINT_MISSING` |
| `MCPX_LOOKUP_TABLE` | no | MCPX-owned warmed ALT; required for any fee-secured candidate to fit |

Website side (Lovable Cloud, later): `MCPX_TX_BUILDER_URL`, `MCPX_TX_BUILDER_SECRET`.

## Routes
- `GET /health` → `{ok:true}`; `GET /ready` → config/SDK/quote/recipient/ALT status (no addresses, `launchEnabled:false`).
- `POST /internal/v1/launch/prepare` (`launch.prepare`) — creation only: create_v2 + fee sharing config + 60/25/15 update. A requested initial buy is refused with `INITIAL_BUY_MUST_BE_SEPARATE`, never dropped. With chain deps the candidate is simulated (sigVerify off, nothing sent) and `feeConfigVerified` is true only when the program's events show creator 10000 → exact 60/25/15.
- `POST /internal/v1/launch/inspect` (`launch.inspect`) — re-checks a candidate against its MAC'd binding.
- `POST /internal/v1/launch/status` (`launch.status`) — `NOT_FOUND` / `CREATED_FEE_VERIFIED` / `CREATED_FEE_MISMATCH`; RPC outage is `UNKNOWN`, never `NOT_FOUND`.
- `POST /internal/v1/launch/prepare-buy` (`launch.prepare_buy`) — separate optional buy (buy_v3 / exact-quote), only after status is `CREATED_FEE_VERIFIED`; `requiresExplicitUserApproval: true`, `priceGuaranteed: false`.

### Failure recovery
After an unknown creation outcome: poll `status` with the **same mint**. Never prepare with a new mint
until `status` is `NOT_FOUND` *and* the candidate's `lastValidBlockHeight` has passed. Re-using the same
mint makes a duplicate coin impossible (create_v2 fails if the mint exists). A mint found with the wrong
fee shares is `CREATED_FEE_MISMATCH` and must not be bought into or listed.

### Evidence tools (read-only)
`node scripts/simulate-proxy.mjs <PROXY_PARENT_MINT>` · `node scripts/alt-plan.mjs <MCP_MINT> <OPS> <PLATFORM>` · see ALT_PROVISIONING.md.
- Anything else: 404, or 405 with `Allow`.

### Auth
Headers `x-mcpx-timestamp` (ms), `x-mcpx-nonce` (uuid), `x-mcpx-scope`, `x-mcpx-signature` =
hex HMAC-SHA256(secret, `ts.nonce.scope.METHOD.path.sha256hex(body)`). ±5 min skew, single-use nonce,
16 KiB body, JSON only, 30 req/min, 4 in flight. `scripts/` contains no signing helper for production keys.

### Prepare request (`mcpx.launch.prepare.v1`)
`{schema, idempotencyKey, creator, mint, name, symbol, uri, initialBuy: null | {mode, quoteAmount, slippageBps}, format}`
— extra fields are refused. Fee recipients, split (6000/2500/1500), quote mint, RPC, programs and ALT are server-fixed.
Responses: `BLOCKED` with reasons, or `UNSIGNED_CANDIDATE` with message, MAC'd binding (60 s TTL) and evidence.
`launchReady` is always `false`; `simulation: SIMULATION_NOT_RUN`.

## Local
`npm ci && npm test` (isolated fixtures only) · `npm run measure` (size table, fixture-labelled).
