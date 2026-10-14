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
- Template catalogue lives in src/lib/templates.ts: LIBRARY is the canonical ten-template registry with explicit id→toolId→route mappings; TEMPLATES (launchable subset) is unchanged. Live execution only from status endpoints; MCP/launch flags test-checked against ADAPTERS/TEMPLATES, so labels never claim unbuilt capability.
- Every route sets errorComponent: RouteError so a failing section never takes down the whole app.
- Verified creations registry (mcp_creations) is publicly readable on safe columns only and writable solely by a future server-side verifier; never grant browser writes.
- outbox_events has no browser access; a verified creation and its outbox event must be written in one Postgres transaction by the server.
- Registry reads go through src/lib/registry.ts (bounded pages, no polling, failures never shown as "empty").
- Creator session: one CreatorSessionProvider (src/lib/creator-auth/session-context.tsx) mounted inside WalletBoundary owns session read, explicit signIn and wallet-bound sign-out; all pages read it via useCreatorSession — so connect, verify and sign-out stay consistent site-wide.
- Wallet: one Reown AppKit instance created in src/components/mcpx/wallet/WalletRuntime.tsx, lazy-loaded client-only via WalletBoundary in __root, rendering null and reporting state up so page content never remounts; UI reads state only through useWallet() (src/lib/wallet). A connected wallet is never treated as an authenticated identity.
- Wallet: vite.config.ts plugin "mcpx-browser-buffer" resolves `buffer` and `events` to their npm packages in the client build, and WalletBoundary sets globalThis.Buffer inside its lazy loader before importing WalletRuntime — production otherwise stubs `buffer` as empty and `"sideEffects": false` drops side-effect-only polyfill imports (dev masks both; the published site crashes).
- Data ownership and refresh rules are documented in docs/DATA_REFRESH.md; registry query keys never include wallet state so wallet changes cannot refetch public data.
- Tool execution: browser → same-origin proxy src/routes/api/tools/wallet-inspector.ts (validates, rate-limits via service-role-only `mcpx_rate_limit_take`, HMAC-signs) → separate Render worker in services/mcp-worker (only holder of the RPC key; no DB, no signing) — keeps keys out of the browser.
- Tool CTAs render only when the proxy GET reports the worker ready, else "not connected" text.
- Tool relays share src/lib/tools/relay.ts (website relays also pass their toolId for a per-tool daily free-test bucket, taken after shared buckets; MCP never passes it): one visitor+global rate-limit budget ("tools:*" buckets) across all tools, and a tool is enabled only when the worker's /ready lists its tool id — adding tools must never multiply capacity or show "live" before the worker is redeployed.
- Creator auth: server-built SIWS-style message + single-use 5-min nonce (mcpx_auth_challenges, consumed atomically before signature check) → Ed25519 verify via WebCrypto → opaque session whose SHA-256 is stored in mcpx_creator_sessions, sent only as `__Host-mcpx_creator` HttpOnly Secure SameSite=Strict cookie; mutations require same-origin Origin + `x-mcpx-csrf: 1` + JSON. Logic in src/lib/creator-auth/core.ts (injectable store), persistence in store.server.ts. Management (/api/creator/products) re-checks session wallet == mcp_creations.creator_wallet every request; session cookies never authenticate MCP endpoints and bearer keys never authenticate management.
- Product profiles: /mcp/$slug resolves slug → canonical mcp_creations.id via a server function (src/lib/product-profile.ts, injectable deps; production in product-profile.server.ts) that returns only an allowlisted profile (describeSettings() text, never raw tool_config) and an endpoint URL only when the product is active and its adapter resolves, so public pages can never advertise an unusable MCP endpoint.
- Subdirectories with their own AGENTS.md (read first): services/transaction-builder, services/mcp-worker, src/lib/mcp-gateway, src/lib/rewards, src/lib/launch, src/lib/byok, src/lib/canvas, src/lib/treasury.
- Operator tools: /operator/* pages read only from /api/operator/* routes, which return 403 unless the creator SIWS session wallet equals the authorised deployer; the server only accepts the exact validated lookup-table create/extend (deployer-signed in the operator's own wallet, resume rule re-checked at confirmed commitment) and never holds keys — operator powers never depend on hidden URLs.
- Tool activity: product MCP endpoints record one row per external call (Canvas = one per request) via service-role-only `mcpx_tool_activity_record` (idempotent on execution_ref, 90-day retention), gated by `MCPX_TOOL_ACTIVITY=1`; recording is awaited with a short timeout and failures are swallowed so it never changes tool results; the dashboard shows activity only when that flag is on.
