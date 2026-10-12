CREATE TABLE public.mcpx_launch_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_wallet text NOT NULL CHECK (length(creator_wallet) BETWEEN 32 AND 44),
  create_key text NOT NULL CHECK (create_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ARTWORK_SAVED','METADATA_VALIDATED','READY_FOR_FUTURE_PREPARATION','ABANDONED')),
  chain_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (chain_status = 'NOT_STARTED'),
  template_id text NOT NULL CHECK (length(template_id) <= 64),
  template_version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_name text NOT NULL CHECK (length(product_name) <= 48),
  token_name text NOT NULL CHECK (octet_length(token_name) <= 32),
  symbol text NOT NULL CHECK (symbol ~ '^[A-Za-z0-9]{1,10}$'),
  description text NOT NULL CHECK (octet_length(description) <= 500),
  link text CHECK (link IS NULL OR (length(link) <= 200 AND link LIKE 'https://%')),
  buy_preference jsonb,
  artwork_id uuid,
  metadata_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  abandoned_at timestamptz,
  UNIQUE (creator_wallet, create_key)
);
CREATE INDEX mcpx_launch_drafts_wallet_idx ON public.mcpx_launch_drafts (creator_wallet, updated_at DESC);

CREATE TABLE public.mcpx_launch_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_wallet text NOT NULL,
  draft_id uuid NOT NULL REFERENCES public.mcpx_launch_drafts(id) ON DELETE RESTRICT,
  draft_revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('artwork','metadata')),
  object_path text NOT NULL UNIQUE,
  public_url text NOT NULL CHECK (length(public_url) <= 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','application/json')),
  bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 5000000),
  width integer, height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, kind, sha256, draft_revision)
);
CREATE INDEX mcpx_launch_artifacts_wallet_idx ON public.mcpx_launch_artifacts (creator_wallet, created_at DESC);

-- Contract-only ledger for future creation attempts. Nothing writes here in 04-E.
CREATE TABLE public.mcpx_launch_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  draft_id uuid NOT NULL REFERENCES public.mcpx_launch_drafts(id) ON DELETE RESTRICT,
  draft_revision integer NOT NULL,
  creator_wallet text NOT NULL,
  mint_pubkey text,
  state text NOT NULL DEFAULT 'PREPARED_UNSIGNED' CHECK (state IN ('PREPARED_UNSIGNED','AWAITING_SIGNATURES','SUBMITTED','CONFIRMED','FEE_VERIFIED','FAILED','EXPIRED','UNKNOWN_OUTCOME','FEE_MISMATCH')),
  artwork_sha256 text, metadata_sha256 text,
  config_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  blockhash text, blockhash_expires_at timestamptz,
  signature text,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.mcpx_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.mint_pubkey IS NOT NULL AND NEW.mint_pubkey IS DISTINCT FROM OLD.mint_pubkey THEN RAISE EXCEPTION 'mint_immutable'; END IF;
    IF NEW.draft_id <> OLD.draft_id OR NEW.draft_revision <> OLD.draft_revision OR NEW.idempotency_key <> OLD.idempotency_key THEN RAISE EXCEPTION 'attempt_identity_immutable'; END IF;
    IF OLD.state IN ('UNKNOWN_OUTCOME','SUBMITTED') AND NEW.state IN ('PREPARED_UNSIGNED','AWAITING_SIGNATURES','EXPIRED') THEN RAISE EXCEPTION 'uncertain_outcome_cannot_regress'; END IF;
  END IF;
  IF NEW.state IN ('SUBMITTED','CONFIRMED','FEE_VERIFIED','FEE_MISMATCH','UNKNOWN_OUTCOME') AND (NEW.signature IS NULL OR NEW.mint_pubkey IS NULL) THEN RAISE EXCEPTION 'state_requires_signature_and_mint'; END IF;
  IF NEW.state IN ('CONFIRMED','FEE_VERIFIED','FEE_MISMATCH') AND NEW.evidence IS NULL THEN RAISE EXCEPTION 'state_requires_evidence'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER mcpx_attempt_guard BEFORE INSERT OR UPDATE ON public.mcpx_launch_attempts FOR EACH ROW EXECUTE FUNCTION public.mcpx_attempt_guard();

REVOKE ALL ON public.mcpx_launch_drafts, public.mcpx_launch_artifacts, public.mcpx_launch_attempts FROM anon, authenticated;
GRANT ALL ON public.mcpx_launch_drafts, public.mcpx_launch_artifacts, public.mcpx_launch_attempts TO service_role;
ALTER TABLE public.mcpx_launch_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcpx_launch_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcpx_launch_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: browser roles have no access; the server authorizes by creator session wallet.