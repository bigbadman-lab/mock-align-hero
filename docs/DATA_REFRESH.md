# MCPX data owners and refresh rules (Phase 01-D)

| Data | Source of truth | Consumers | Key / read | Read trigger | Future invalidation | Timeout / retry | Outage UI |
|---|---|---|---|---|---|---|---|
| Template definitions | `src/lib/templates.ts` (static, versioned) | `/`, `/mcp`, registry name lookup | import | build time | code release only | n/a | n/a |
| Wallet | Reown AppKit singleton (`WalletRuntime`) | Header, phone menu, Dashboard via `useWallet()` | React context | Reown events | Reown events | 30 s connect stall → error + Retry | "Wallet unavailable" + reload |
| Verified creations | Cloud `mcp_creations` restricted public columns | `/paired` only | `["registry","verified-creations",page]` (TanStack Query) | route mount, explicit Retry | planned: server verifier outbox event → invalidate `["registry"]` | 10 s abort, no auto-retry, no polling, 5 min stale, max 25 rows | "Registry unavailable" + Retry (never shown as empty) |
| Creator earnings, rewards, tool activity, markets | none (not built) | Dashboard shows "Later phase" | none | none | planned: fee ledger, $MCP mint, execution worker, market indexer | n/a | static unavailable text |

Rules: wallet state never enters a registry query key; a wallet-filtered query (if ever added) must use its own key `["registry","by-creator",address,page]` and be labelled an unverified public match.
