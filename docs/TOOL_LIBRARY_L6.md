# Tool Library L6 — Smart Money Tracker + Onchain Report Builder

Status: PARTIAL. Code complete and tested; real mainnet reads verified in-process with the test key. Not deployed to the Render mcp-worker, so both pages honestly show "not available yet".

## Preflight (repository state)
- L5 present: Holder Intelligence and Token Risk Analyst have worker handlers, relays, MCP adapters and tests. They are not deployed either. Report Builder does not use them: it uses the four tools that are already live.
- Free tests: 3 per tool per UTC day through `mcpx_free_test_take` (applied 2026-10-13). MCP calls never pass a toolId. Shared buckets unchanged (6/min, 40/h per visitor; 60/min global).

## Architecture
browser → `/api/tools/{smart-money-tracker,onchain-report-builder}` (validate, shared + free buckets, HMAC sign) → Render worker (`tracker.mjs`, `report.mjs`) → Helius RPC.
- Report Builder composes worker functions in-process (`inspectWallet`, `checkAccount`, `scanToken`, `monitorSupply`). It never re-enters the relays, so one report takes one free test and one shared-budget slot.
- MCP adapters: `smart-money-tracker@1.0.0` takes `{wallets[1..3]}` and `onchain-report-builder@1.0.0` takes `{targetType, target}`. Neither has product settings, and neither is launchable (`tokenLaunch: false`), so no product can expose them yet.

## Contracts
- `mcpx.tool-execution.smart-money-tracker.v1`:
  - Per wallet: signatures (slot, blockTime|null, succeeded, detail state), decoded native SOL transfers, highlights (≥ 1 SOL, fixed), counts and window.
  - `complete` is false on any unreadable, partly decoded or budget-cut item.
- `mcpx.tool-execution.onchain-report.v1`:
  - Fields: components (tool, schema, required, status, error), findings (text + evidence), limitations and usage.
  - `status` is "partial" whenever a component is not ok. A required failure returns an error (fail closed).
  - The validator rejects a partial report labelled complete.

## Budgets
| Tool | Calls | Time |
|---|---|---|
| Smart Money Tracker | ≤ 3 signature lists (20 each) + ≤ 5 getTransaction per wallet = ≤ 18; concurrency 3; failed txs not fetched | one 16 s deadline |
| Report — wallet | 4 (getBalance, 2× getTokenAccountsByOwner, getAccountInfo); hard budget 6 | one 16 s deadline |
| Report — token | 5 (getAccountInfo ×2, getTokenSupply ×2, getTokenLargestAccounts); hard budget 6 | one 16 s deadline |

## Limitations (shown in UI and MCP descriptions)
- Tracker: sample only (20 signatures, 5 decoded per wallet). Native SOL only: no token transfers, swaps, PnL or claims about who the wallets are. No monitoring or alerts.
- Report: point-in-time only. No prices, history, scores or safety verdicts. Chain-supplied text (names, extension states) is not copied into findings; extension names are reduced to alphanumerics.

## Read-only mainnet evidence (2026-10-13, test key, worker functions in-process)
- Tracker, wallets `5Q544f…ge4j1` and `9WzDXw…AWWM`: 12 calls, 233 ms, `complete: false`.
  - Wallet 1: 20 signatures, 6 failed, 5 unreadable (very busy wallet). It was reported, not hidden.
  - Wallet 2: 5 decoded, 2 native SOL transfers, none ≥ 1 SOL.
- Report, wallet `5Q544f…`: 4 calls, PARTIAL. Wallet Inspector was partial (a token program unreadable). Findings: SOL balance 34.599136271; 155 mints, flagged as maybe incomplete; system-owned account.
- Report, token `8M6Wh…pump` (Token-2022): 5 calls, 125 ms, complete. Authorities empty; metadataPointer + tokenMetadata extensions; top 20 accounts hold 99.7473%.
- Report, token USDC: 5 calls, PARTIAL. Both authorities set; the largest-accounts list was refused by the provider, so concentration is shown as unknown.
- Not done: an end-to-end run through the deployed worker and relay (needs redeploy).

## Tests
- `bunx vitest run`: 321 passed, 11 skipped (34 files). New: `src/test/tool-library-l6.test.ts`.
- Typecheck clean.

## Files
- New worker modules: services/mcp-worker/src/tracker.mjs, report.mjs.
- New tool contracts: src/lib/tools/smart-money-tracker.ts, onchain-report.ts.
- New relay routes: src/routes/api/tools/smart-money-tracker.ts, onchain-report-builder.ts.
- New pages: src/routes/tools.smart-money-tracker.tsx, tools.onchain-report-builder.tsx.
- New tests: src/test/tool-library-l6.test.ts.
- Edited: services/mcp-worker/src/server.mjs, src/lib/templates.ts, src/lib/tools/status.ts, src/lib/mcp-gateway/registry.ts, src/components/mcpx/TemplateAvailability.tsx, src/components/mcpx/MintToolShell.tsx, src/test/tool-library-l1.test.ts, src/test/intelligence-l5.test.ts.
- Untouched: rewards, holder index, snapshots, launch, signing, database.

## Deployment dependencies (need approval)
1. Redeploy the Render mcp-worker from services/mcp-worker. This adds holder_intelligence, token_risk_analyst, smart_money_tracker and onchain_report_builder to /ready. No new env vars.
2. Then run one live check per tool through the website and record the evidence.
3. Publish.
