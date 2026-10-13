<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Shared site frame (nav/footer) lives in src/components/mcpx/AppShell.tsx, mounted once in __root around <Outlet /> — one shell for all routes.
- Template catalogue is static product definition in src/lib/templates.ts — it is not live tool data; future live data must come from a separate cached query layer.
- Every route sets errorComponent: RouteError so a failing section never takes down the whole app.
- Verified creations registry (mcp_creations) is publicly readable on safe columns only and writable solely by a future server-side verifier; never grant browser writes.
- outbox_events has no browser access; a verified creation and its outbox event must be written in one Postgres transaction by the server.
- Registry reads go through src/lib/registry.ts (bounded pages, no polling, failures never shown as "empty").
- Wallet: one Reown AppKit instance created in src/components/mcpx/wallet/WalletRuntime.tsx, lazy-loaded client-only via WalletBoundary in __root, rendering null and reporting state up so page content never remounts; UI reads state only through useWallet() (src/lib/wallet). A connected wallet is never treated as an authenticated identity.
- Wallet: vite.config.ts plugin "mcpx-browser-buffer" resolves `buffer` and `events` to their npm packages in the client build, and WalletBoundary sets globalThis.Buffer inside its lazy loader before importing WalletRuntime — production otherwise stubs `buffer` as empty and `"sideEffects": false` drops side-effect-only polyfill imports (dev masks both; the published site crashes).
- Data ownership and refresh rules are documented in docs/DATA_REFRESH.md; registry query keys never include wallet state so wallet changes cannot refetch public data.
- Tool execution: browser → same-origin proxy src/routes/api/tools/wallet-inspector.ts (validates, rate-limits via service-role-only `mcpx_rate_limit_take`, HMAC-signs) → separate Render worker in services/mcp-worker (only holder of the RPC key; no DB, no signing) — keeps provider credentials and execution out of the website and browser.
- Tool CTAs render only when the proxy's GET reports the worker ready; otherwise honest "not connected" text — Publish = Live.
- Tool relays share src/lib/tools/relay.ts: one visitor+global rate-limit budget ("tools:*" buckets) across all tools, and a tool is enabled only when the worker's /ready lists its tool id — adding tools must never multiply capacity or show "live" before the worker is redeployed.
- External MCP gateway: src/lib/mcp-gateway (official @modelcontextprotocol/server, stateless createMcpHandler) served at /api/public/mcp/<profile>; bearer token checked before protocol work, tools resolve through a versioned adapter registry (templateId+version) and reuse relay.ts shared buckets and signed worker calls — so MCP can't bypass site quotas and new templates are registration-only.
- Creator auth: server-built SIWS-style message + single-use 5-min nonce (mcpx_auth_challenges, consumed atomically before signature check) → Ed25519 verify via WebCrypto → opaque session whose SHA-256 is stored in mcpx_creator_sessions, sent only as `__Host-mcpx_creator` HttpOnly Secure SameSite=Strict cookie; mutations require same-origin Origin + `x-mcpx-csrf: 1` + JSON. Logic in src/lib/creator-auth/core.ts (injectable store), persistence in store.server.ts. Management (/api/creator/products) re-checks session wallet == mcp_creations.creator_wallet every request; session cookies never authenticate MCP endpoints and bearer keys never authenticate management.
- Product profiles: /mcp/$slug resolves slug → canonical mcp_creations.id via a server function (src/lib/product-profile.ts, injectable deps; production in product-profile.server.ts) that returns only an allowlisted profile — adapter describeSettings() text, never raw tool_config — and an endpoint URL only when the product is active and its adapter resolves, so public pages can never advertise an unusable MCP endpoint.

- services/transaction-builder has its own AGENTS.md — read it before changing launch/transaction code.
- src/lib/mcp-gateway has its own AGENTS.md (product endpoints, product access keys).- Launch: /launch never signs or sends; drafts/artwork/metadata rules live in src/lib/launch/AGENTS.md.
- Native rewards use one deployer wallet (feeModel SINGLE_DEPLOYER, native-single.ts): ledger-enforced 30/30/40, no onchain sharing or extra treasuries — keeps MVP to one signer.
- Native rewards (src/lib/rewards): pure integer economics/epochs/snapshot/ledger with injectable store; tables mcpx_rw_* are service-role only, append-only, carry-chained and conservation-checked in SQL; no execution paths — fee proof = Pump self-CPI events with event-authority check (pump-events.ts); the window processor (processor.ts) emits DRY_RUN plans only; durable state via store.pg.ts + SQL mcpx_rw_commit_window (DB re-derives totals, single lease, +1-window watermark); runs only in services/rewards-worker (Background Worker), never the MCP tool worker or a site request; see docs/REWARDS_05A.md.
