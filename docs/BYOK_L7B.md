# L7-B — Creator BYOK management (status: on by default; L7-C wired to product MCP)

- Route: `/api/creator/ai` (GET availability; POST actions get_status, get_usage, connect_or_replace, rotate, test_connection, set_enabled, set_model_and_limits, revoke_and_remove). Cookie session + per-request ownership; bearer headers refused; CSRF via readMutation.
- On by default. Fails closed only if `MCPX_BYOK_KEYRING` is missing/invalid. Emergency stop: set `MCPX_BYOK_DISABLED=1` (management returns 503, product MCP drops ai_summary; nothing is deleted).
- Requires migration `drizzle/migrations/0015_mcpx_l7b_byok_health.sql` (health columns, set_enabled/set_model_limits/record_health/purge functions, audit actions). Applied 2026-10-13.
- Connection check: fixed endpoint, `max_tokens: 1`, 10 s timeout, redirect refused, 4 KB bounded body, never returned. Budget: 2/min and 10/h per product, 30/min global.
- Status mapping: 200 ok; 401 invalid_key (auto-pause, key kept); 403 no_permission (ambiguous); 429 insufficient_quota → no_credit (held); 429 other rate_limited; 404/model_not_found model_unavailable; 5xx/timeout/network provider_error.
- Retention: `mcpx_ai_purge_usage(batch ≤ 5000)` deletes non-reserved usage rows older than 90 days before UTC midnight; idempotent; never touches audit/credentials/integrations. Runs opportunistically (≈2% of AI settlements, one 500-row batch); an operator can also run it until it returns 0.
- UI: `ProductAiKey` inside each product in creator management; write-only password field (autocomplete=new-password), confirm before checks/replace/remove; shows informational text only while switched off.

## L7-C execution
- Product MCP (/api/public/mcp/products/<id>): when the product's BYOK state is Active, its one tool gains optional `ai_summary`. Summary = one fixed OpenAI chat call with the creator's key (no tools), input capped by maxInputTokens, output by maxOutputTokens, 20 s timeout, admitted/settled atomically. Timeout/network/5xx = ambiguous (charged at reservation). 401 auto-pauses; insufficient_quota holds.
