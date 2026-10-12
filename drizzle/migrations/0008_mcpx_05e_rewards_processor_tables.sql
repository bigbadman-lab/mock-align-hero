-- Phase 05-E: durable state for the dry-run rewards window processor. Additive only; service-role only; no execution paths.
CREATE TABLE public.mcpx_rw_sharing_receipts (
  receipt_key text PRIMARY KEY,
  signature text NOT NULL, ix_index integer NOT NULL CHECK (ix_index >= 0), event_index integer NOT NULL CHECK (event_index >= 0),
  program_id text NOT NULL, mint text NOT NULL, sharing_config text NOT NULL,
  slot bigint NOT NULL CHECK (slot > 0), block_time timestamptz NOT NULL, commitment text NOT NULL CHECK (commitment = 'finalized'),
  window_start timestamptz NOT NULL CHECK (extract(epoch FROM window_start)::bigint % 300 = 0),
  rewards_recipient text NOT NULL, rewards_lamports numeric(20,0) NOT NULL CHECK (rewards_lamports >= 0 AND rewards_lamports <= 18446744073709551615),
  operations_recipient text NOT NULL, operations_lamports numeric(20,0) NOT NULL CHECK (operations_lamports >= 0 AND operations_lamports <= 18446744073709551615),
  sol_budget numeric(20,0) NOT NULL, buyback_budget numeric(20,0) NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signature, ix_index, event_index),
  CHECK (receipt_key = signature || ':' || ix_index || ':' || event_index),
  CHECK (rewards_recipient <> operations_recipient),
  CHECK (sol_budget = floor(rewards_lamports / 2) AND sol_budget + buyback_budget = rewards_lamports),
  CHECK (window_start <= block_time AND block_time < window_start + interval '300 seconds')
);
CREATE INDEX mcpx_rw_sharing_receipts_window ON public.mcpx_rw_sharing_receipts (window_start);

CREATE TABLE public.mcpx_rw_policies (
  version text PRIMARY KEY, config jsonb NOT NULL, config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by text, approved_at timestamptz, effective_from_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (approved_at IS NULL OR effective_from_slot IS NOT NULL)
);

CREATE TABLE public.mcpx_rw_proc_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  watermark timestamptz CHECK (watermark IS NULL OR extract(epoch FROM watermark)::bigint % 300 = 0),
  lease_owner text, lease_until timestamptz, heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.mcpx_rw_proc_state (id) VALUES (1);

CREATE TABLE public.mcpx_rw_window_plans (
  window_start timestamptz PRIMARY KEY CHECK (extract(epoch FROM window_start)::bigint % 300 = 0),
  plan_id text NOT NULL UNIQUE CHECK (plan_id ~ '^plan_[0-9a-f]{32}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  processor_version text NOT NULL, policy_version text,
  mode text NOT NULL CHECK (mode = 'DRY_RUN'),
  status text NOT NULL CHECK (status IN ('PLANNED','HELD','CANCELLED')),
  hold_reasons text[] NOT NULL DEFAULT '{}',
  rewards_total numeric(30,0) NOT NULL CHECK (rewards_total >= 0), operations_total numeric(30,0) NOT NULL CHECK (operations_total >= 0),
  sol_budget numeric(30,0) NOT NULL CHECK (sol_budget >= 0), buyback_budget numeric(30,0) NOT NULL CHECK (buyback_budget >= 0),
  snapshot_slot bigint, plan jsonb NOT NULL,
  committed_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sol_budget + buyback_budget = rewards_total),
  CHECK (status <> 'PLANNED' OR rewards_total = 0 OR cardinality(hold_reasons) = 0)
);

CREATE TABLE public.mcpx_rw_receipt_consumption (
  receipt_key text PRIMARY KEY REFERENCES public.mcpx_rw_sharing_receipts(receipt_key),
  window_start timestamptz NOT NULL REFERENCES public.mcpx_rw_window_plans(window_start),
  kind text NOT NULL CHECK (kind IN ('OWN','ADJUSTMENT'))
);

CREATE TABLE public.mcpx_rw_owner_carry (
  window_start timestamptz NOT NULL REFERENCES public.mcpx_rw_window_plans(window_start),
  owner text NOT NULL, lamports numeric(30,0) NOT NULL CHECK (lamports > 0),
  PRIMARY KEY (window_start, owner)
);

CREATE TABLE public.mcpx_rw_proc_runs (
  id bigserial PRIMARY KEY, worker_id text NOT NULL, correlation_id text NOT NULL,
  window_start timestamptz, outcome text NOT NULL, reason text, at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mcpx_rw_sharing_receipts','mcpx_rw_policies','mcpx_rw_proc_state','mcpx_rw_window_plans','mcpx_rw_receipt_consumption','mcpx_rw_owner_carry','mcpx_rw_proc_runs'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.mcpx_rw_proc_runs_id_seq TO service_role;

CREATE TRIGGER mcpx_rw_sharing_receipts_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_sharing_receipts FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_policies_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_policies FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_window_plans_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_window_plans FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_receipt_consumption_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_receipt_consumption FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_owner_carry_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_owner_carry FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_proc_runs_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_proc_runs FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();

CREATE OR REPLACE FUNCTION public.mcpx_rw_proc_state_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'proc_state_delete_forbidden'; END IF;
  IF NEW.watermark IS DISTINCT FROM OLD.watermark AND NOT (
    (OLD.watermark IS NULL AND NEW.watermark IS NOT NULL) OR NEW.watermark = OLD.watermark + interval '300 seconds'
  ) THEN RAISE EXCEPTION 'watermark_must_advance_one_window'; END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER mcpx_rw_proc_state_guard BEFORE UPDATE OR DELETE ON public.mcpx_rw_proc_state FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_proc_state_guard();

CREATE OR REPLACE FUNCTION public.mcpx_rw_cursor_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF OLD.last_slot IS NOT NULL AND (NEW.last_slot IS NULL OR NEW.last_slot < OLD.last_slot) THEN RAISE EXCEPTION 'cursor_must_be_monotonic'; END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER mcpx_rw_cursor_guard BEFORE UPDATE ON public.mcpx_rw_cursors FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_cursor_guard();

CREATE OR REPLACE FUNCTION public.mcpx_rw_acquire_lease(_owner text, _ttl_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n int;
BEGIN
  IF _ttl_seconds < 5 OR _ttl_seconds > 600 OR length(_owner) < 3 OR length(_owner) > 120 THEN RAISE EXCEPTION 'invalid_lease_args'; END IF;
  UPDATE mcpx_rw_proc_state SET lease_owner = _owner, lease_until = now() + make_interval(secs => _ttl_seconds), heartbeat_at = now()
  WHERE id = 1 AND (lease_owner IS NULL OR lease_until < now() OR lease_owner = _owner);
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;
CREATE OR REPLACE FUNCTION public.mcpx_rw_release_lease(_owner text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE mcpx_rw_proc_state SET lease_owner = NULL, lease_until = NULL WHERE id = 1 AND lease_owner = _owner;
$$;

CREATE OR REPLACE FUNCTION public.mcpx_rw_commit_window(_owner text, _expected timestamptz, _window timestamptz, _plan jsonb,
  _own text[], _adj text[], _carry jsonb, _processor_version text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE st record; rw numeric; op numeric; sb numeric; bb numeric; n int; k text; c record;
BEGIN
  SELECT * INTO st FROM mcpx_rw_proc_state WHERE id = 1 FOR UPDATE;
  IF st.lease_owner IS DISTINCT FROM _owner OR st.lease_until < now() THEN RETURN 'LEASE_LOST'; END IF;
  IF st.watermark IS DISTINCT FROM _expected THEN RETURN 'RACE_LOST'; END IF;
  IF _expected IS NOT NULL AND _window <> _expected + interval '300 seconds' THEN RAISE EXCEPTION 'non_contiguous_window'; END IF;
  SELECT count(*) INTO n FROM mcpx_rw_sharing_receipts WHERE receipt_key = ANY(_own) AND window_start = _window;
  IF n <> coalesce(cardinality(_own),0) THEN RAISE EXCEPTION 'own_receipt_mismatch'; END IF;
  SELECT count(*) INTO n FROM mcpx_rw_sharing_receipts WHERE receipt_key = ANY(_adj) AND window_start < _window;
  IF n <> coalesce(cardinality(_adj),0) THEN RAISE EXCEPTION 'adjustment_receipt_mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM mcpx_rw_sharing_receipts r WHERE r.window_start <= _window
             AND NOT EXISTS (SELECT 1 FROM mcpx_rw_receipt_consumption x WHERE x.receipt_key = r.receipt_key)
             AND NOT (r.receipt_key = ANY(coalesce(_own,'{}') || coalesce(_adj,'{}')))) THEN RAISE EXCEPTION 'unconsumed_receipt_omitted'; END IF;
  SELECT coalesce(sum(rewards_lamports),0), coalesce(sum(operations_lamports),0), coalesce(sum(sol_budget),0), coalesce(sum(buyback_budget),0)
    INTO rw, op, sb, bb FROM mcpx_rw_sharing_receipts WHERE receipt_key = ANY(coalesce(_own,'{}') || coalesce(_adj,'{}'));
  IF rw <> (_plan->>'rewardsTotal')::numeric OR op <> (_plan->>'operationsTotal')::numeric OR sb <> (_plan->>'solBudget')::numeric OR bb <> (_plan->>'buybackBudget')::numeric
    THEN RAISE EXCEPTION 'plan_totals_mismatch'; END IF;
  IF (_plan->>'mode') <> 'DRY_RUN' THEN RAISE EXCEPTION 'dry_run_only'; END IF;
  INSERT INTO mcpx_rw_window_plans (window_start, plan_id, input_digest, processor_version, policy_version, mode, status, hold_reasons,
    rewards_total, operations_total, sol_budget, buyback_budget, snapshot_slot, plan, committed_by)
  VALUES (_window, _plan->>'planId', _plan->>'inputDigest', _processor_version, _plan->>'snapshotConfigVersion', 'DRY_RUN', _plan->>'status',
    ARRAY(SELECT jsonb_array_elements_text(_plan->'holdReasons')), rw, op, sb, bb, (_plan->>'snapshotSlot')::bigint, _plan, _owner);
  FOREACH k IN ARRAY coalesce(_own,'{}') LOOP INSERT INTO mcpx_rw_receipt_consumption VALUES (k, _window, 'OWN'); END LOOP;
  FOREACH k IN ARRAY coalesce(_adj,'{}') LOOP INSERT INTO mcpx_rw_receipt_consumption VALUES (k, _window, 'ADJUSTMENT'); END LOOP;
  FOR c IN SELECT key AS owner, value::numeric AS lamports FROM jsonb_each_text(coalesce(_carry,'{}'::jsonb)) LOOP
    INSERT INTO mcpx_rw_owner_carry VALUES (_window, c.owner, c.lamports);
  END LOOP;
  UPDATE mcpx_rw_proc_state SET watermark = _window, heartbeat_at = now() WHERE id = 1;
  RETURN 'COMMITTED';
END $$;

REVOKE ALL ON FUNCTION public.mcpx_rw_acquire_lease(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_rw_release_lease(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_rw_commit_window(text, timestamptz, timestamptz, jsonb, text[], text[], jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_acquire_lease(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_release_lease(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_commit_window(text, timestamptz, timestamptz, jsonb, text[], text[], jsonb, text) TO service_role;