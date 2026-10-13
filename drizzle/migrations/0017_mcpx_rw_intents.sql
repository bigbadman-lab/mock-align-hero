-- 0016: durable signing intents for the rewards deployer signer. Additive only: one new table, one trigger function.
-- A row is reserved BEFORE signing; the idempotency key is the primary key so a crash, retry or second worker can
-- never reserve (and therefore sign) the same payout twice. Signing never means paid: LANDED needs finalized evidence.
CREATE TABLE IF NOT EXISTS public.mcpx_rw_intents (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  cycle_id text NOT NULL CHECK (length(cycle_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('SOL_PAYOUT','TOKEN_PAYOUT','FEE_COLLECTION','BUYBACK','WSOL_UNWRAP')),
  message_sha256 text NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
  lamports numeric(20,0) NOT NULL CHECK (lamports >= 0),
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  signature text,
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','SIGNED','LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED','ABANDONED_UNSIGNED')),
  finalized_slot bigint,
  evidence jsonb,
  reserved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('SIGNED','LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED') OR signature IS NOT NULL),
  CHECK (state NOT IN ('LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED') OR (finalized_slot IS NOT NULL AND evidence IS NOT NULL)),
  CHECK (state <> 'ABANDONED_UNSIGNED' OR signature IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS mcpx_rw_intents_signature ON public.mcpx_rw_intents (signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcpx_rw_intents_cycle ON public.mcpx_rw_intents (cycle_id);
CREATE INDEX IF NOT EXISTS mcpx_rw_intents_open ON public.mcpx_rw_intents (state) WHERE state IN ('RESERVED','SIGNED');

REVOKE ALL ON public.mcpx_rw_intents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mcpx_rw_intents TO service_role;
ALTER TABLE public.mcpx_rw_intents ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (site server via the sealed worker bridge) can reach it.

CREATE OR REPLACE FUNCTION public.mcpx_rw_intents_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mcpx_rw_intents is append-only'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'RESERVED' OR NEW.signature IS NOT NULL THEN RAISE EXCEPTION 'intent must start RESERVED and unsigned'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.cycle_id <> OLD.cycle_id OR NEW.kind <> OLD.kind
     OR NEW.message_sha256 <> OLD.message_sha256 OR NEW.lamports <> OLD.lamports
     OR NEW.last_valid_block_height <> OLD.last_valid_block_height OR NEW.reserved_by <> OLD.reserved_by OR NEW.created_at <> OLD.created_at
    THEN RAISE EXCEPTION 'intent body is immutable'; END IF;
  IF OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature THEN RAISE EXCEPTION 'signature is immutable'; END IF;
  IF OLD.state IN ('LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED','ABANDONED_UNSIGNED') THEN RAISE EXCEPTION 'intent is final'; END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'RESERVED' AND NEW.state IN ('SIGNED','ABANDONED_UNSIGNED')) OR
       (OLD.state = 'SIGNED' AND NEW.state IN ('LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED'))
     ) THEN RAISE EXCEPTION 'illegal intent transition %->%', OLD.state, NEW.state; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_rw_intents_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS mcpx_rw_intents_guard ON public.mcpx_rw_intents;
CREATE TRIGGER mcpx_rw_intents_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mcpx_rw_intents
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_intents_guard();
