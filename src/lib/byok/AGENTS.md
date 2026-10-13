# BYOK (optional creator-paid AI) — rules
- Server-only module. Never import from browser code. Creator management is /api/creator/ai (cookie session, on by default; MCPX_BYOK_DISABLED=1 is an emergency stop; fails closed if the keyring doesn't parse); no public/MCP route may manage BYOK.
- Keys are sealed with AES-256-GCM (crypto.ts) using a keyring from a server secret (MCPX_BYOK_KEYRING), AAD = product + credential ref, so ciphertext copied between products cannot decrypt.
- DB (migration 0014, applied) is service-role only; state changes go through mcpx_ai_put_credential / mcpx_ai_revoke / mcpx_ai_admit / mcpx_ai_settle, which lock the integration row so revoke, rotate and admission serialise.
- Retired/revoked credentials are crypto-shredded (ciphertext NULL); a revoked integration is never revived by rotate — only an explicit connect starts a fresh, paused config.
- Every operation runs authorizeCreator first; provider endpoints are fixed in providers.ts (no user base URL); test_connection is one fixed 1-token OpenAI call (openai-test.ts); only HTTP 401 counts as a bad key and auto-pauses (never revokes); results bind to the credential version, so a replaced key's result is dropped.
- No key substring is stored or returned (key_hint deprecated, placeholder '----'). 'active' requires enabled + a passing check of the current key; resume is refused otherwise.
- Pause/resume, model/limits, health and the 90-day usage purge run through 0015 SQL functions (migration 0015, applied).
- AI execution (execute.ts) is reached only from the product MCP gateway with a valid product key; it reads state, admits, calls OpenAI once and settles exactly once.
