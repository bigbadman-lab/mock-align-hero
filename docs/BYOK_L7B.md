# L7-B — Creator BYOK management (status: built behind a switch, not enabled)

- Route: `/api/creator/ai` (GET availability; POST actions get_status, get_usage, connect_or_replace, rotate, test_connection, set_enabled, set_model_and_limits, revoke_and_remove). Cookie session + per-request ownership; bearer headers refused; CSRF via readMutation.
- Fails closed (503 byok_not_enabled) unless `MCPX_BYOK_ENABLED=1` AND `MCPX_BYOK_KEYRING` parses. The switch is NOT set.
- Requires pending migration `drizzle/migrations/0015_mcpx_l7b_byok_health.sql` (health columns, set_enabled/set_model_limits/record_health/purge functions, audit actions). NOT applied.
- Connection check: fixed endpoint, `max_tokens: 1`, 10 s timeout, redirect refused, 4 KB bounded body, never returned. Budget: 2/min and 10/h per product, 30/min global.
- Status mapping: 200 ok; 401 invalid_key (auto-pause, key kept); 403 no_permission (ambiguous); 429 insufficient_quota → no_credit (held); 429 other rate_limited; 404/model_not_found model_unavailable; 5xx/timeout/network provider_error.
- Retention: `mcpx_ai_purge_usage(batch ≤ 5000)` deletes non-reserved usage rows older than 90 days before UTC midnight; idempotent; never touches audit/credentials/integrations. Not scheduled — operator runs until it returns 0.
- UI: `ProductAiKey` inside each product in creator management; write-only password field (autocomplete=new-password), confirm before checks/replace/remove; shows informational text only while switched off.
