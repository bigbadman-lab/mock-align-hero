-- CHILD-FEES-01B. Child-token fee keeper state.
-- Completely separate from the native mcpx_rw_* ledger. Service-role only; reached by the worker
-- through the sealed site bridge. Additive only.

CREATE TABLE public.mcpx_cf_children (
  mint text PRIMARY KEY,
  creator_wallet text NOT NULL,
  ops_recipient text NOT NULL,
  platform_recipient text NOT NULL,
  quote_mint text NOT NULL,
  quote_token_program text NOT NULL,
  sharing_config text NOT NULL,
  verified_slot bigint NOT NULL,
  creation_signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (creator_wallet <> ops_recipient AND creator_wallet <> platform_recipient AND ops_recipient <> platform_recipient)
);

CREATE TABLE public.mcpx_cf_intents (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) >= 8),
  mint text NOT NULL REFERENCES public.mcpx_cf_children(mint),
  status text NOT NULL CHECK (status IN ('RESERVED','SIGNED','LANDED','FAILED','EXPIRED')),
  action text NOT NULL CHECK (action IN ('DISTRIBUTE','SWEEP_THEN_DISTRIBUTE')),
  cost_lamports bigint NOT NULL CHECK (cost_lamports >= 0),
  signature text,
  signed_tx_base64 text,
  last_valid_block_height bigint,
  finalized_slot bigint,
  distributed_amount numeric(39,0),
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'RESERVED' OR status = 'EXPIRED' OR (signature IS NOT NULL AND signed_tx_base64 IS NOT NULL)),
  CHECK (status <> 'LANDED' OR (finalized_slot IS NOT NULL AND distributed_amount IS NOT NULL AND evidence IS NOT NULL))
);
CREATE UNIQUE INDEX mcpx_cf_one_open_per_child ON public.mcpx_cf_intents(mint) WHERE status IN ('RESERVED','SIGNED');

CREATE OR REPLACE FUNCTION public.mcpx_cf_intents_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mcpx_cf_intents is append-only'; END IF;
  IF OLD.status IN ('LANDED','FAILED','EXPIRED') THEN RAISE EXCEPTION 'finished child-fee intent is immutable'; END IF;
  IF NOT ((OLD.status = 'RESERVED' AND NEW.status IN ('SIGNED','EXPIRED')) OR (OLD.status = 'SIGNED' AND NEW.status IN ('LANDED','FAILED','EXPIRED')) OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'illegal child-fee transition % -> %', OLD.status, NEW.status; END IF;
  IF OLD.signed_tx_base64 IS NOT NULL AND NEW.signed_tx_base64 IS DISTINCT FROM OLD.signed_tx_base64 THEN RAISE EXCEPTION 'signed bytes immutable'; END IF;
  IF NEW.mint <> OLD.mint OR NEW.cost_lamports <> OLD.cost_lamports OR NEW.action <> OLD.action THEN RAISE EXCEPTION 'intent identity immutable'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER mcpx_cf_intents_guard BEFORE UPDATE OR DELETE ON public.mcpx_cf_intents FOR EACH ROW EXECUTE FUNCTION public.mcpx_cf_intents_guard();

GRANT ALL ON public.mcpx_cf_children TO service_role;
GRANT ALL ON public.mcpx_cf_intents TO service_role;
ALTER TABLE public.mcpx_cf_children ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcpx_cf_intents ENABLE ROW LEVEL SECURITY;
-- No policies: no browser access. Creator dashboard reads go through an authenticated server function
-- that re-checks session wallet = creator_wallet and returns only LANDED (confirmed) and open (pending) states.
