-- MCPX Phase 01-B: verified creations registry + outbox. Both start empty.
CREATE TABLE IF NOT EXISTS public.mcp_creations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$' AND slug !~ '--'),
  template_id text NOT NULL CHECK (template_id IN ('wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker')),
  template_version integer NOT NULL CHECK (template_version > 0),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 64 AND display_name !~ '[<>]'),
  ticker text NOT NULL CHECK (ticker ~ '^[A-Z0-9]{1,10}$'),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500 AND description !~ '[<>]'),
  creator_wallet text NOT NULL CHECK (creator_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  child_mint text NOT NULL UNIQUE CHECK (child_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  quote_mint text NOT NULL CHECK (quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  network text NOT NULL CHECK (network = 'solana-mainnet'),
  verified_tx_signature text NOT NULL UNIQUE CHECK (verified_tx_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  verified_slot bigint NOT NULL CHECK (verified_slot > 0),
  verified_at timestamptz NOT NULL,
  fee_config_evidence_id text CHECK (fee_config_evidence_id IS NULL OR fee_config_evidence_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (child_mint <> quote_mint)
);
CREATE INDEX IF NOT EXISTS mcp_creations_verified_order_idx ON public.mcp_creations (verified_at DESC, id DESC);

-- Public may read only these columns; no one but the server role may write.
REVOKE ALL ON public.mcp_creations FROM anon, authenticated;
GRANT SELECT (id, slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at, created_at)
  ON public.mcp_creations TO anon, authenticated;
GRANT ALL ON public.mcp_creations TO service_role;
ALTER TABLE public.mcp_creations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can read verified creations" ON public.mcp_creations;
CREATE POLICY "Public can read verified creations" ON public.mcp_creations FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.mcpx_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); NEW.created_at = OLD.created_at; NEW.id = OLD.id; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS mcp_creations_touch ON public.mcp_creations;
CREATE TRIGGER mcp_creations_touch BEFORE UPDATE ON public.mcp_creations FOR EACH ROW EXECUTE FUNCTION public.mcpx_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,63}$'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  aggregate_id text NOT NULL CHECK (char_length(aggregate_id) BETWEEN 1 AND 128),
  event_version integer NOT NULL CHECK (event_version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 16384),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.outbox_events FROM anon, authenticated;
GRANT ALL ON public.outbox_events TO service_role;
ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: browsers have no access.