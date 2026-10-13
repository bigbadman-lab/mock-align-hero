-- L7-B/L7-C. Additive: connection health, auto-pause on a confirmed invalid key, revision-guarded pause/resume and
-- model/limit updates as atomic functions (service role only), and a bounded 90-day usage purge.
ALTER TABLE public.mcpx_ai_integrations
  ADD COLUMN health text NOT NULL DEFAULT 'unchecked'
    CHECK (health IN ('unchecked','ok','invalid_key','no_permission','no_credit','rate_limited','model_unavailable','provider_error')),
  ADD COLUMN health_credential_version integer,
  ADD COLUMN health_checked_at timestamptz;

ALTER TABLE public.mcpx_ai_audit DROP CONSTRAINT IF EXISTS mcpx_ai_audit_action_check;
ALTER TABLE public.mcpx_ai_audit ADD CONSTRAINT mcpx_ai_audit_action_check
  CHECK (action IN ('connect','replace','rotate','enable','pause','set_model_limits','revoke','health_check','auto_pause'));

COMMENT ON COLUMN public.mcpx_ai_credentials.key_hint IS 'DEPRECATED (L7-B): no key substring is stored or shown; new rows store a fixed placeholder.';

CREATE OR REPLACE FUNCTION public.mcpx_ai_set_enabled(_creation uuid, _wallet text, _enabled boolean, _expected_rev integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.mcpx_ai_integrations; v integer;
BEGIN
  SELECT * INTO i FROM public.mcpx_ai_integrations WHERE creation_id = _creation FOR UPDATE;
  IF NOT FOUND OR i.creator_wallet <> _wallet THEN RETURN 'not_found'; END IF;
  IF i.status = 'revoked' THEN RETURN 'revoked'; END IF;
  IF i.revision <> _expected_rev THEN RETURN 'stale_revision'; END IF;
  IF _enabled THEN
    SELECT version INTO v FROM public.mcpx_ai_credentials WHERE integration_id = i.id AND status = 'active';
    IF v IS NULL OR i.health_credential_version IS DISTINCT FROM v OR i.health <> 'ok' THEN RETURN 'needs_passing_test'; END IF;
  END IF;
  UPDATE public.mcpx_ai_integrations SET enabled = _enabled, revision = revision + 1, updated_at = now() WHERE id = i.id RETURNING * INTO i;
  INSERT INTO public.mcpx_ai_audit (integration_id, action, actor_ref, revision)
    VALUES (i.id, CASE WHEN _enabled THEN 'enable' ELSE 'pause' END, left('wallet:' || _wallet, 96), i.revision);
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_ai_set_model_limits(_creation uuid, _wallet text, _model text, _conc integer, _pm integer,
  _pd integer, _in integer, _out integer, _expected_rev integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.mcpx_ai_integrations;
BEGIN
  SELECT * INTO i FROM public.mcpx_ai_integrations WHERE creation_id = _creation FOR UPDATE;
  IF NOT FOUND OR i.creator_wallet <> _wallet THEN RETURN 'not_found'; END IF;
  IF i.status = 'revoked' THEN RETURN 'revoked'; END IF;
  IF i.revision <> _expected_rev THEN RETURN 'stale_revision'; END IF;
  UPDATE public.mcpx_ai_integrations SET model = _model, max_concurrency = _conc, max_per_minute = _pm, max_per_day = _pd,
    max_input_tokens = _in, max_output_tokens = _out,
    health = CASE WHEN model <> _model THEN 'unchecked' ELSE health END,
    revision = revision + 1, updated_at = now() WHERE id = i.id RETURNING * INTO i;
  INSERT INTO public.mcpx_ai_audit (integration_id, action, actor_ref, revision) VALUES (i.id, 'set_model_limits', left('wallet:' || _wallet, 96), i.revision);
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_ai_record_health(_creation uuid, _wallet text, _cred_version integer, _health text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.mcpx_ai_integrations; v integer;
BEGIN
  IF _health NOT IN ('ok','invalid_key','no_permission','no_credit','rate_limited','model_unavailable','provider_error') THEN RETURN 'invalid_input'; END IF;
  SELECT * INTO i FROM public.mcpx_ai_integrations WHERE creation_id = _creation FOR UPDATE;
  IF NOT FOUND OR i.creator_wallet <> _wallet THEN RETURN 'not_found'; END IF;
  IF i.status = 'revoked' THEN RETURN 'revoked'; END IF;
  SELECT version INTO v FROM public.mcpx_ai_credentials WHERE integration_id = i.id AND status = 'active';
  IF v IS DISTINCT FROM _cred_version THEN RETURN 'stale'; END IF;
  UPDATE public.mcpx_ai_integrations SET health = _health, health_credential_version = v, health_checked_at = now(),
    enabled = CASE WHEN _health = 'invalid_key' THEN false ELSE enabled END,
    revision = revision + 1, updated_at = now() WHERE id = i.id RETURNING * INTO i;
  INSERT INTO public.mcpx_ai_audit (integration_id, action, actor_ref, revision)
    VALUES (i.id, CASE WHEN _health = 'invalid_key' THEN 'auto_pause' ELSE 'health_check' END, left('wallet:' || _wallet, 96), i.revision);
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_ai_purge_usage(_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF _batch IS NULL OR _batch < 1 OR _batch > 5000 THEN RAISE EXCEPTION 'invalid_batch'; END IF;
  WITH victims AS (
    SELECT id FROM public.mcpx_ai_usage
     WHERE status <> 'reserved' AND created_at < (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '90 days'
     ORDER BY created_at LIMIT _batch FOR UPDATE SKIP LOCKED)
  DELETE FROM public.mcpx_ai_usage u USING victims WHERE u.id = victims.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT DELETE ON public.mcpx_ai_usage TO service_role;
REVOKE ALL ON FUNCTION public.mcpx_ai_set_enabled(uuid,text,boolean,integer), public.mcpx_ai_set_model_limits(uuid,text,text,integer,integer,integer,integer,integer,integer),
  public.mcpx_ai_record_health(uuid,text,integer,text), public.mcpx_ai_purge_usage(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_ai_set_enabled(uuid,text,boolean,integer), public.mcpx_ai_set_model_limits(uuid,text,text,integer,integer,integer,integer,integer,integer),
  public.mcpx_ai_record_health(uuid,text,integer,text), public.mcpx_ai_purge_usage(integer) TO service_role;
