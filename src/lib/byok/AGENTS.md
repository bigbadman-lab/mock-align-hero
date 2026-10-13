# BYOK (optional creator-paid AI) — rules
- Server-only module. Never import from browser code; no public route is wired until L7-C approval.
- Keys are sealed with AES-256-GCM (crypto.ts) using a keyring from a server secret (MCPX_BYOK_KEYRING), AAD = product + credential ref, so ciphertext copied between products cannot decrypt.
- DB (migration 0014, applied) is service-role only; state changes go through mcpx_ai_put_credential / mcpx_ai_revoke / mcpx_ai_admit / mcpx_ai_settle, which lock the integration row so revoke, rotate and admission serialise.
- Retired/revoked credentials are crypto-shredded (ciphertext NULL); a revoked integration is never revived by rotate — only an explicit connect starts a fresh, paused config.
- Every operation runs authorizeCreator first; provider endpoints are fixed in providers.ts (no user base URL); test_connection must not report success before a real provider call exists.
