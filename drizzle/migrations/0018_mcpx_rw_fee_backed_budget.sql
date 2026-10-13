-- 0018 (PENDING REVIEW): fee-backed budgets for the deployer signer. Additive only.
-- 1) intents record which epoch funds them, token amounts and operations cost (network fee + priority + rent);
-- 2) finalized buyback fills = the only source of token-payout budget;
-- 3) mcpx_rw_budget_remaining(epoch): remaining SOL / buyback / token budget for an epoch + pooled ops reserve,
--    derived only from CREDITED finalized fee events for the configured mint+deployer and live (non-freed) intents.
ALTER TABLE public.mcpx_rw_intents
  ADD COLUMN IF NOT EXISTS epoch_start timestamptz,
  ADD COLUMN IF NOT EXISTS token_amount numeric(39,0) NOT NULL DEFAULT 0 CHECK (token_amount >= 0),
  ADD COLUMN IF NOT EXISTS ops_cost_lamports numeric(20,0) NOT NULL DEFAULT 0 CHECK (ops_cost_lamports >= 0);
CREATE INDEX IF NOT EXISTS mcpx_rw_intents_epoch ON public.mcpx_rw_intents (epoch_start, kind);

CREATE TABLE IF NOT EXISTS public.mcpx_rw_buyback_fills (
  signature text PRIMARY KEY,
  intent_key text NOT NULL REFERENCES public.mcpx_rw_intents (idempotency_key),
  epoch_start timestamptz NOT NULL,
  mint text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  token_amount numeric(39,0) NOT NULL CHECK (token_amount > 0),
  sol_spent numeric(20,0) NOT NULL CHECK (sol_spent > 0),
  finalized_slot bigint NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.mcpx_rw_buyback_fills FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.mcpx_rw_buyback_fills TO service_role;
ALTER TABLE public.mcpx_rw_buyback_fills ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.mcpx_rw_fills_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE i record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'mcpx_rw_buyback_fills is append-only'; END IF;
  SELECT kind, state, signature, epoch_start INTO i FROM public.mcpx_rw_intents WHERE idempotency_key = NEW.intent_key;
  IF i.kind IS DISTINCT FROM 'BUYBACK' OR i.state IS DISTINCT FROM 'LANDED' OR i.signature IS DISTINCT FROM NEW.signature OR i.epoch_start IS DISTINCT FROM NEW.epoch_start
    THEN RAISE EXCEPTION 'fill requires a LANDED buyback intent with the same signature and epoch'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_rw_fills_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS mcpx_rw_fills_guard ON public.mcpx_rw_buyback_fills;
CREATE TRIGGER mcpx_rw_fills_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mcpx_rw_buyback_fills FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_fills_guard();

-- New intent columns are immutable like the rest of the body.
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
     OR NEW.epoch_start IS DISTINCT FROM OLD.epoch_start OR NEW.token_amount <> OLD.token_amount OR NEW.ops_cost_lamports <> OLD.ops_cost_lamports
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

CREATE OR REPLACE FUNCTION public.mcpx_rw_budget_remaining(p_epoch timestamptz)
RETURNS TABLE (sol numeric, buyback numeric, tokens numeric, ops numeric, evidence boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH cfg AS (SELECT mint, deployer_wallet FROM public.mcpx_rw_config WHERE id = 1 AND mint IS NOT NULL AND deployer_wallet IS NOT NULL),
  alloc AS (
    SELECT a.epoch_start, a.holder_sol, a.buyback, a.operations
    FROM public.mcpx_rw_allocations a JOIN public.mcpx_rw_fee_events e ON e.event_key = a.event_key JOIN cfg ON e.mint = cfg.mint AND e.recipient = cfg.deployer_wallet
    WHERE e.status = 'CREDITED' AND e.commitment = 'finalized'),
  live AS (SELECT * FROM public.mcpx_rw_intents WHERE state NOT IN ('EXPIRED_NOT_LANDED','ABANDONED_UNSIGNED','FAILED_ON_CHAIN'))
  SELECT
    coalesce((SELECT sum(holder_sol) FROM alloc WHERE epoch_start = p_epoch), 0) - coalesce((SELECT sum(lamports) FROM live WHERE kind = 'SOL_PAYOUT' AND epoch_start = p_epoch), 0),
    coalesce((SELECT sum(buyback) FROM alloc WHERE epoch_start = p_epoch), 0) - coalesce((SELECT sum(lamports) FROM live WHERE kind = 'BUYBACK' AND epoch_start = p_epoch), 0),
    coalesce((SELECT sum(f.token_amount) FROM public.mcpx_rw_buyback_fills f JOIN cfg ON f.mint = cfg.mint WHERE f.epoch_start = p_epoch), 0)
      - coalesce((SELECT sum(token_amount) FROM live WHERE kind = 'TOKEN_PAYOUT' AND epoch_start = p_epoch), 0),
    coalesce((SELECT sum(operations) FROM alloc), 0) - coalesce((SELECT sum(ops_cost_lamports) FROM live), 0),
    EXISTS (SELECT 1 FROM alloc WHERE epoch_start = p_epoch)
$$;
REVOKE ALL ON FUNCTION public.mcpx_rw_budget_remaining(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_budget_remaining(timestamptz) TO service_role;