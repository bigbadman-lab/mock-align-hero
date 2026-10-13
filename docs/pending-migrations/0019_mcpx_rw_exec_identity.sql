-- 0019 (PENDING APPROVAL): replay-safe execution identity for mcpx_rw_intents. Additive only, server-only rights unchanged.
-- Signed bytes are stored together with SIGNED (before any send) so a crash after broadcast can only resend the SAME bytes.
-- "Submitted" = SIGNED with first_sent_at set; no state-constraint change needed.
ALTER TABLE public.mcpx_rw_intents
  ADD COLUMN IF NOT EXISTS signed_tx_base64 text,
  ADD COLUMN IF NOT EXISTS first_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  ADD COLUMN IF NOT EXISTS batch_id text;
CREATE UNIQUE INDEX IF NOT EXISTS mcpx_rw_intents_batch ON public.mcpx_rw_intents (batch_id) WHERE batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.mcpx_rw_intents_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mcpx_rw_intents is append-only'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'RESERVED' OR NEW.signature IS NOT NULL OR NEW.signed_tx_base64 IS NOT NULL OR NEW.first_sent_at IS NOT NULL OR NEW.send_count <> 0
      THEN RAISE EXCEPTION 'intent must start RESERVED, unsigned and unsent'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.cycle_id <> OLD.cycle_id OR NEW.kind <> OLD.kind
     OR NEW.message_sha256 <> OLD.message_sha256 OR NEW.lamports <> OLD.lamports
     OR NEW.last_valid_block_height <> OLD.last_valid_block_height OR NEW.reserved_by <> OLD.reserved_by OR NEW.created_at <> OLD.created_at
     OR NEW.epoch_start IS DISTINCT FROM OLD.epoch_start OR NEW.token_amount <> OLD.token_amount OR NEW.ops_cost_lamports <> OLD.ops_cost_lamports
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    THEN RAISE EXCEPTION 'intent body is immutable'; END IF;
  IF OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature THEN RAISE EXCEPTION 'signature is immutable'; END IF;
  IF OLD.signed_tx_base64 IS NOT NULL AND NEW.signed_tx_base64 IS DISTINCT FROM OLD.signed_tx_base64 THEN RAISE EXCEPTION 'signed bytes are immutable'; END IF;
  IF OLD.first_sent_at IS NOT NULL AND NEW.first_sent_at IS DISTINCT FROM OLD.first_sent_at THEN RAISE EXCEPTION 'first_sent_at is immutable'; END IF;
  IF NEW.send_count < OLD.send_count THEN RAISE EXCEPTION 'send_count only increases'; END IF;
  IF (NEW.first_sent_at IS NOT NULL OR NEW.send_count > 0) AND NEW.signed_tx_base64 IS NULL THEN RAISE EXCEPTION 'cannot send without persisted signed bytes'; END IF;
  IF OLD.state IN ('LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED','ABANDONED_UNSIGNED') THEN RAISE EXCEPTION 'intent is final'; END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'RESERVED' AND NEW.state IN ('SIGNED','ABANDONED_UNSIGNED')) OR
       (OLD.state = 'SIGNED' AND NEW.state IN ('LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED'))
     ) THEN RAISE EXCEPTION 'illegal intent transition %->%', OLD.state, NEW.state; END IF;
  IF OLD.state = 'RESERVED' AND NEW.state = 'SIGNED' AND NEW.signed_tx_base64 IS NULL THEN RAISE EXCEPTION 'SIGNED requires persisted signed bytes'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
