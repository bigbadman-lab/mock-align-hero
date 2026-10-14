# MCPX data owners and refresh rules (Phase 01-D)

| Data | Source of truth | Consumers | Key / read | Read trigger | Future invalidation | Timeout / retry | Outage UI |
|---|---|---|---|---|---|---|---|
| Template definitions | `src/lib/templates.ts` (static, versioned) | `/`, `/mcp`, registry name lookup | import | build time | code release only | n/a | n/a |
| Wallet | Reown AppKit singleton (`WalletRuntime`) | Header, phone menu, Dashboard via `useWallet()` | React context | Reown events | Reown events | 30 s connect stall → error + Retry | "Wallet unavailable" + reload |
| Verified creations | Cloud `mcp_creations` restricted public columns | `/paired` only | `["registry","verified-creations",page]` (TanStack Query); per-row FDV via `["token-market",slug]` refetched every 30 s | route mount, explicit Retry | planned: server verifier outbox event → invalidate `["registry"]` | 10 s abort, no auto-retry, no polling, 5 min stale, max 25 rows | "Registry unavailable" + Retry (never shown as empty) |
| Creator earnings, rewards, tool activity, markets | none (not built) | Dashboard shows "Later phase" | none | none | planned: fee ledger, $MCP mint, execution worker, market indexer | n/a | static unavailable text |

Rules: wallet state never enters a registry query key; a wallet-filtered query (if ever added) must use its own key `["registry","by-creator",address,page]` and be labelled an unverified public match.

## Phase 01-E additions

- A registry read that failed is not re-fetched just by re-opening `/paired` (`retryOnMount: false`); only Retry re-reads. A successful read is reused for 5 minutes.
- The Cloud client itself retries failed network requests a few times inside one logical read (seen as up to 4 HTTP attempts); the 10 s abort still caps the whole read.
- Wallet state is reported up to `WalletBoundary`; the page tree never remounts when the wallet SDK loads or fails.
- Dev-only `console.debug("[registry] …")` logs page, outcome category and elapsed ms. Nothing in production.
- Reown makes its own requests (observed: `api.web3modal.org`, `fonts.reown.com`) even with analytics off.

## Proposed future events — NOT IMPLEMENTED

Names are proposals only; no events are emitted, no consumer or bus exists.

| Event | Producer (future) | Would invalidate |
|---|---|---|
| `creation.verified.v1` | privileged verified-creation writer | `["registry"]` |
| `tool.execution.completed.v1` | MCP tool runtime | tool activity keys |
| `market.snapshot.updated.v1` | market service | market keys |
| `finance.settlement.confirmed.v1` | financial workers | earnings / rewards keys |

The future verified-creation writer must insert the `mcp_creations` row and its `outbox_events` row in one transaction. No such writer exists in this phase.

## Wallet Inspector (Phase 02-A)
- Availability: one GET `/api/tools/wallet-inspector` per 5 min max, no focus/reconnect refetch, not wallet-keyed.
- Execution: only on explicit Inspect/Retry click. No auto-run, no polling, no cache. Results are not stored anywhere.
