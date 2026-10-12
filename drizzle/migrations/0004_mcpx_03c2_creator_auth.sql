-- MCPX Phase 03-C2: durable wallet sign-in challenges and creator sessions. Server-only; only hashes stored.
-- ROLLBACK: DROP TABLE public.mcpx_creator_sessions; DROP TABLE public.mcpx_auth_challenges;
CREATE TABLE public.mcpx_auth_challenges (
  nonce_hash text PRIMARY KEY CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  wallet text NOT NULL CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  domain text NOT NULL CHECK (char_length(domain) BETWEEN 3 AND 128),
  message text NOT NULL CHECK (char_length(message) BETWEEN 50 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX mcpx_auth_challenges_expiry_idx ON public.mcpx_auth_challenges (expires_at);
REVOKE ALL ON public.mcpx_auth_challenges FROM anon, authenticated;
GRANT ALL ON public.mcpx_auth_challenges TO service_role;
ALTER TABLE public.mcpx_auth_challenges ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.mcpx_creator_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  wallet text NOT NULL CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  network text NOT NULL CHECK (network = 'solana-mainnet'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX mcpx_creator_sessions_expiry_idx ON public.mcpx_creator_sessions (expires_at);
REVOKE ALL ON public.mcpx_creator_sessions FROM anon, authenticated;
GRANT ALL ON public.mcpx_creator_sessions TO service_role;
ALTER TABLE public.mcpx_creator_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: browsers have no direct access.