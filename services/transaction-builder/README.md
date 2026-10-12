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
- `POST /internal/v1/launch/prepare` (scope `launch.prepare`), `POST /internal/v1/launch/inspect` (scope `launch.inspect`).
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
