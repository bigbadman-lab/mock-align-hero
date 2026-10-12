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
