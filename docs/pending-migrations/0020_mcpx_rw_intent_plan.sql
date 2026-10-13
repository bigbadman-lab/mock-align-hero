-- 0020 (PENDING APPROVAL): persist the exact plan each intent was signed for, so a restarted worker can verify
-- finalized settlement against what was approved (recipients, amounts, mint, token program, message bytes) — never
-- against anything re-derived later. Additive only; server-only rights unchanged; set once at insert, then immutable.
ALTER TABLE public.mcpx_rw_intents
  ADD COLUMN IF NOT EXISTS plan_rows jsonb,
  ADD COLUMN IF NOT EXISTS plan_mint text,
  ADD COLUMN IF NOT EXISTS plan_token_program text,
  ADD COLUMN IF NOT EXISTS message_base64 text;

CREATE OR REPLACE FUNCTION public.mcpx_rw_intent_plan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.plan_rows IS NOT NULL AND jsonb_typeof(NEW.plan_rows) <> 'array' THEN RAISE EXCEPTION 'plan_rows must be an array'; END IF;
    IF NEW.message_base64 IS NOT NULL AND encode(sha256(decode(NEW.message_base64, 'base64')), 'hex') <> NEW.message_sha256
      THEN RAISE EXCEPTION 'message_base64 does not match message_sha256'; END IF;
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
