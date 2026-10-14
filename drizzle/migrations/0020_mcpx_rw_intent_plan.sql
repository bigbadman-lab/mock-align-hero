-- 0020: persist the exact plan each intent was signed for, so a restarted worker can verify finalized settlement
-- against what was approved (recipients, amounts, mint, token program, message bytes) — never against anything
-- re-derived later. Additive only; server-only rights unchanged; set once at insert, then immutable.
ALTER TABLE public.mcpx_rw_intents
  ADD COLUMN IF NOT EXISTS plan_rows jsonb,
  ADD COLUMN IF NOT EXISTS plan_mint text,
  ADD COLUMN IF NOT EXISTS plan_token_program text,
  ADD COLUMN IF NOT EXISTS message_base64 text;

CREATE OR REPLACE FUNCTION public.mcpx_rw_intent_plan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE total numeric; bad int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.plan_rows IS NOT NULL AND jsonb_typeof(NEW.plan_rows) <> 'array' THEN RAISE EXCEPTION 'plan_rows must be an array'; END IF;
    IF NEW.message_base64 IS NOT NULL AND encode(sha256(decode(NEW.message_base64, 'base64')), 'hex') <> NEW.message_sha256
      THEN RAISE EXCEPTION 'message_base64 does not match message_sha256'; END IF;
    IF NEW.kind IN ('SOL_PAYOUT','TOKEN_PAYOUT') THEN
      IF NEW.plan_rows IS NULL OR NEW.message_base64 IS NULL OR jsonb_array_length(NEW.plan_rows) = 0
        THEN RAISE EXCEPTION 'payout intent requires plan_rows and message_base64'; END IF;
      SELECT count(*) FILTER (WHERE jsonb_typeof(r->'owner') <> 'string' OR jsonb_typeof(r->'amount') <> 'string'
                                 OR (r->>'amount') !~ '^[1-9][0-9]{0,38}$'),
             coalesce(sum(CASE WHEN (r->>'amount') ~ '^[1-9][0-9]{0,38}$' THEN (r->>'amount')::numeric END), 0)
        INTO bad, total FROM jsonb_array_elements(NEW.plan_rows) r;
      IF bad > 0 THEN RAISE EXCEPTION 'plan_rows entries must be {owner, amount>0 as integer string}'; END IF;
      IF (SELECT count(DISTINCT r->>'owner') FROM jsonb_array_elements(NEW.plan_rows) r) <> jsonb_array_length(NEW.plan_rows)
        THEN RAISE EXCEPTION 'plan_rows owners must be unique'; END IF;
      IF NEW.kind = 'SOL_PAYOUT' AND total <> NEW.lamports THEN RAISE EXCEPTION 'plan_rows total does not match lamports'; END IF;
      IF NEW.kind = 'TOKEN_PAYOUT' AND (total <> NEW.token_amount OR NEW.plan_mint IS NULL OR NEW.plan_token_program IS NULL)
        THEN RAISE EXCEPTION 'token plan requires matching total, mint and token program'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.plan_rows IS DISTINCT FROM OLD.plan_rows OR NEW.plan_mint IS DISTINCT FROM OLD.plan_mint
     OR NEW.plan_token_program IS DISTINCT FROM OLD.plan_token_program OR NEW.message_base64 IS DISTINCT FROM OLD.message_base64
    THEN RAISE EXCEPTION 'intent plan is immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_rw_intent_plan_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS mcpx_rw_intent_plan_guard ON public.mcpx_rw_intents;
CREATE TRIGGER mcpx_rw_intent_plan_guard BEFORE INSERT OR UPDATE ON public.mcpx_rw_intents FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_intent_plan_guard();
