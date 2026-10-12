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
- Wallet: one Reown AppKit instance created in src/components/mcpx/wallet/WalletRuntime.tsx, lazy-loaded client-only via WalletBoundary in __root; UI reads state only through useWallet() (src/lib/wallet). A connected wallet is never treated as an authenticated identity.
- Wallet: vite.config.ts plugin "mcpx-browser-buffer" resolves `buffer` to the npm package in the client build, and WalletBoundary sets globalThis.Buffer inside its lazy loader before importing WalletRuntime — production otherwise stubs `buffer` as empty and `"sideEffects": false` drops side-effect-only polyfill imports (dev masks both; the published site crashes).
