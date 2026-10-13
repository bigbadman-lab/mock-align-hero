CREATE TABLE public.mcpx_rw_hix_checkpoints (
  mint text PRIMARY KEY,
  anchor_slot bigint NOT NULL,
  covered_to_slot bigint NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (covered_to_slot >= anchor_slot)
);
CREATE TABLE public.mcpx_rw_hix_applied_txs (
  mint text NOT NULL,
  signature text NOT NULL,
  slot bigint NOT NULL,
  block_time timestamptz,
  failed boolean NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, signature)
);
CREATE TABLE public.mcpx_rw_hix_balances (
  mint text NOT NULL,
  token_account text NOT NULL,
  owner text,
  amount numeric(20,0) NOT NULL CHECK (amount >= 0),
  last_signature text NOT NULL,
  last_slot bigint NOT NULL,
  PRIMARY KEY (mint, token_account)
);
CREATE TABLE public.mcpx_rw_hix_gaps (
  id bigserial PRIMARY KEY,
  mint text NOT NULL,
  from_slot bigint NOT NULL,
  to_slot bigint NOT NULL,
  reason text NOT NULL,
  repaired_at timestamptz,
  repaired_by_source text,
  CHECK (to_slot >= from_slot),
  UNIQUE (mint, from_slot, to_slot)
);
CREATE TABLE public.mcpx_rw_hix_snapshots (
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  slot bigint NOT NULL,
  supply numeric(20,0) NOT NULL,
  holder_count integer NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, window_start)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mcpx_rw_hix_checkpoints','mcpx_rw_hix_applied_txs','mcpx_rw_hix_balances','mcpx_rw_hix_gaps','mcpx_rw_hix_snapshots'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.mcpx_rw_hix_gaps_id_seq TO service_role;