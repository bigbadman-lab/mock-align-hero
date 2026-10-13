# L7-A — BYOK security foundation

Status: code + pending migration only. No route wired, no provider call, nothing applied to production.

## Prerequisite reconciliation
- Ten-template registry (`src/lib/templates.ts` LIBRARY), ten tool pages, ten proxies, ten MCP adapters: present and tested.
- L5/L6 tools: PARTIAL — code + tests + limited mainnet reads; the Render worker is NOT redeployed, so the four new tools are not live. BYOK is therefore coupled only to product records (`mcp_creations` / `mcp_product_configs`), not to any tool runtime.
- Token launch: NOT IMPLEMENTED in production — `/launch` never signs/sends, no deployed transaction builder; `mcp_creations` has 0 rows (verified products only come from a future server verifier). No post-launch lifecycle can be proven yet.
- Creator auth: SIWS → `__Host-mcpx_creator` session; ownership via `authorizeCreator` (session wallet == `mcp_creations.creator_wallet`, config not suspended). Reused unchanged.
- Secrets (names only): MCPX_WORKER_URL/SECRET, MCPX_TX_BUILDER_URL/SECRET, MCPX_PRODUCT_KEY_PEPPER, MCPX_HELIUS_TEST_API_KEY, MCPX_MCP_TEST_TOKEN, LOVABLE_API_KEY, LOVABLE_CRON_SECRET. No BYOK key exists yet; MCPX_BYOK_KEYRING is required.

## Trust boundaries
```text
Browser (creator) --HTTPS, session cookie + CSRF--> Same-origin server (Cloudflare Worker)
   | never receives ciphertext/plaintext after submit      | authorizeCreator every request
                                                          | seal/open with MCPX_BYOK_KEYRING (server secret)
                                                          v
                                    Postgres (service_role only; ciphertext + metadata)
L7-B runtime: server --fixed https endpoint--> OpenAI      (Render worker never sees provider keys)
```

## Threat model (summary)
| Threat | Control |
|---|---|
| Credential exfiltration (DB dump, public roles) | AES-256-GCM ciphertext only; KEK outside DB; anon/authenticated have no table/function privileges (tested) |
| Cross-tenant access / forged product id | authorizeCreator before any store call; SQL functions re-check creator_wallet (tested) |
| Ciphertext transplant | AAD = product id + credential ref (tested) |
| Replay / duplicate | idempotency key unique per integration; request_ref unique per usage |
| Rotate/revoke races | row lock serialises; revoked never revived by rotate; old ciphertext shredded (tested) |
| Cost exhaustion | per-product concurrency, per-minute, per-UTC-day and token caps, admitted atomically (tested with 8 parallel connections) |
| Prompt injection (L7-B) | fixed server instructions; tool output passed as data; schema-validated, size-bounded output |
| Proxy spoofing / SSRF | fixed provider endpoint allowlist; no user base URL |
| Logging leakage | responses carry last-4 hint only; `redact()` for logs/errors |
| Provider outage | AI optional: tool result always returned; failures settle as `failed` |

## Data model (pending `docs/pending-migrations/0014_mcpx_l7a_byok.sql`)
- `mcpx_ai_integrations`: one per product (UNIQUE creation_id → mcp_creations), creator_wallet, provider (`openai`), model, status, enabled (default false), revision, limits with DB CHECK ceilings.
- `mcpx_ai_credentials`: versioned; alg, kek_version, iv, ciphertext, last-4 hint; one active per integration (partial unique index); non-active rows must have NULL ciphertext.
- `mcpx_ai_usage`: reservation rows (reserved/settled/failed/ambiguous/expired), token counts, cost estimate; indexes for window counts. Retention: 90 days proposed (cleanup job in L7-B).
- `mcpx_ai_audit`: action, actor, revision, time — no secret content.
- RLS on, no policies, service_role grants only. Functions are SECURITY DEFINER, EXECUTE revoked from public roles.

## Operations (`src/lib/byok/core.ts`, redacted contract)
| Action | Input | Result |
|---|---|---|
| connect_or_replace | provider, apiKey, model, idempotencyKey, expectedRevision | redacted status |
| test_connection | — | 501 not_implemented (L7-B) |
| get_status | — | provider, model, status, enabled, revision, keyHint, limits |
| set_enabled | enabled, expectedRevision | ok / 409 |
| set_model_and_limits | model, limits, expectedRevision | ok / 400 / 409 |
| rotate | provider, apiKey, idempotencyKey, expectedRevision | ok / 409 revoked |
| revoke_and_remove | expectedRevision? | ok (idempotent) |
| get_usage | — | today's counts, in-flight |
All: 401 without session, 404 for unknown/foreign/suspended products.

## Keys and rotation
`MCPX_BYOK_KEYRING="v2:<b64>,v1:<b64>"` — first entry encrypts, all decrypt. Rotate KEK: prepend new version, re-seal rows in a server job, then drop old. Missing/invalid keyring fails closed.

## Admission semantics
`mcpx_ai_admit` locks the integration row, checks configured + enabled + product active + credential unchanged + token caps, expires stale leases (60 s) as `ambiguous` charged at the reservation, then checks concurrency/minute/day and inserts a reservation. `mcpx_ai_settle` runs once, clamping usage to the reservation. Any DB error → no admission. Pause/revoke blocks new admissions at commit; an in-flight call finishes with its already-decrypted key (bounded by provider timeout) and still settles.

## L7-B contract (design)
authenticated MCP bearer → product key check → active product + integration → admit → run existing tool → bounded evidence (allowlisted fields, size cap) → OpenAI chat completions with fixed system prompt, JSON schema, max_output_tokens = cap, 20 s timeout, no automatic retry on 5xx/timeout (settle `ambiguous`), 401/403 → mark integration needs-attention, 429 → `failed` → response `{ tool: <authoritative>, ai: { status, interpretation, sources } }`. Website free tests never trigger creator-billed AI.

## L7-C contract (design)
Collapsed "Optional AI (Bring Your Own Key)" in `/launch` records intent only (provider + model, never a key). Key entry happens only in `/dashboard` for verified launched products; controls show "unavailable" while launches are blocked.

## Open questions
1. Approve 0014 for production and creation of MCPX_BYOK_KEYRING?
2. Usage retention period (90 days proposed)?
3. Exact OpenAI models to allow (currently gpt-4o-mini, gpt-4.1-mini)?
4. Should provider 401 auto-pause the integration?
