-- MCPX Phase 05-I.1 — PENDING. NOT applied to production. Requires 0010 first and explicit operator approval.
-- Operator-only recovery for held frozen windows: immutable, NON-PAYABLE candidate rebuilds + an auditable resolution
-- that is allowed ONLY when the candidate reproduces the frozen fingerprint exactly. Frozen rows are never touched.
-- Mismatching candidates have NO resolution path here (BLOCKED: POLICY DECISION REQUIRED).
CREATE TABLE public.mcpx_rw_hix_recovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id uuid NOT NULL UNIQUE,
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  original_digest text NOT NULL,
  candidate_digest text,
  status text NOT NULL CHECK (status IN ('CANDIDATE_MATCH','CANDIDATE_MISMATCH','CANDIDATE_INCOMPLETE')),
  reason text,
  cutoff_slot bigint NOT NULL,
  hold_ids bigint[] NOT NULL,
  comparison jsonb NOT NULL,
  provenance jsonb NOT NULL,
  operator text NOT NULL CHECK (length(operator) BETWEEN 1 AND 100),
  payable boolean NOT NULL DEFAULT false CHECK (payable = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mint, window_start) REFERENCES public.mcpx_rw_hix_frozen_snapshots(mint, window_start),
  CHECK (status <> 'CANDIDATE_MATCH' OR candidate_digest = original_digest),
  CHECK (status <> 'CANDIDATE_MISMATCH' OR (candidate_digest IS NOT NULL AND candidate_digest <> original_digest) OR reason = 'CUTOFF_CHANGED')
);
-- the same rebuild result against the same open holds is recorded once (safe repeated invocation)
CREATE UNIQUE INDEX mcpx_rw_hix_recovery_candidates_dedupe ON public.mcpx_rw_hix_recovery_candidates (mint, window_start, original_digest, coalesce(candidate_digest, ''), status, coalesce(reason, ''), hold_ids);
CREATE INDEX mcpx_rw_hix_recovery_candidates_window ON public.mcpx_rw_hix_recovery_candidates (mint, window_start, created_at);

CREATE TABLE public.mcpx_rw_hix_recovery_decisions (
  id bigserial PRIMARY KEY,
  candidate_id uuid NOT NULL UNIQUE REFERENCES public.mcpx_rw_hix_recovery_candidates(id),
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  decision text NOT NULL CHECK (decision = 'RESOLVE_MATCH'),
  hold_ids bigint[] NOT NULL,
  operator text NOT NULL CHECK (length(operator) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcpx_rw_hix_holds_open ON public.mcpx_rw_hix_holds (mint, window_start) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION public.mcpx_rw_hix_recovery_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'mcpx_rw immutable row in %', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER mcpx_rw_hix_recovery_candidates_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_hix_recovery_candidates FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_recovery_immutable();
CREATE TRIGGER mcpx_rw_hix_recovery_decisions_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_hix_recovery_decisions FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_recovery_immutable();

-- holds: never deleted; only an open hold may be closed, and only by a recorded RESOLVE_MATCH decision naming it
CREATE OR REPLACE FUNCTION public.mcpx_rw_hix_holds_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mcpx_rw holds cannot be deleted' USING ERRCODE = 'P0001'; END IF;
  IF OLD.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'mcpx_rw hold already resolved' USING ERRCODE = 'P0001'; END IF;
  IF NEW.id <> OLD.id OR NEW.mint <> OLD.mint OR NEW.window_start <> OLD.window_start OR NEW.reason <> OLD.reason OR NEW.detail <> OLD.detail OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mcpx_rw hold identity is immutable' USING ERRCODE = 'P0001'; END IF;
  IF NEW.resolved_at IS NULL OR NEW.resolution IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.mcpx_rw_hix_recovery_decisions d
       WHERE NEW.resolution = 'RECOVERY_MATCH:' || d.candidate_id::text AND OLD.id = ANY (d.hold_ids) AND d.mint = OLD.mint AND d.window_start = OLD.window_start) THEN
    RAISE EXCEPTION 'mcpx_rw hold may only be closed by a recorded recovery decision' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mcpx_rw_hix_holds_guard BEFORE UPDATE OR DELETE ON public.mcpx_rw_hix_holds FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_holds_guard();

-- Atomic, concurrency-safe resolution. Refuses: non-match, stale candidate (open holds changed), cutoff/frozen drift,
-- duplicate decisions. Returns a status word; never raises for business refusals.
CREATE OR REPLACE FUNCTION public.mcpx_rw_hix_resolve_window(p_candidate uuid, p_operator text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.mcpx_rw_hix_recovery_candidates; open_ids bigint[]; f_digest text; f_cut bigint;
BEGIN
  IF p_operator IS NULL OR length(p_operator) NOT BETWEEN 1 AND 100 THEN RETURN 'REFUSED_OPERATOR'; END IF;
  SELECT * INTO c FROM public.mcpx_rw_hix_recovery_candidates WHERE id = p_candidate;
  IF NOT FOUND THEN RETURN 'REFUSED_UNKNOWN_CANDIDATE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mcpx_rw_hix_recover:' || c.mint || ':' || c.window_start::text, 0));
  IF EXISTS (SELECT 1 FROM public.mcpx_rw_hix_recovery_decisions WHERE candidate_id = c.id) THEN RETURN 'ALREADY_RESOLVED'; END IF;
  IF c.status <> 'CANDIDATE_MATCH' THEN RETURN 'REFUSED_NOT_MATCH'; END IF;
  SELECT digest, cutoff_slot INTO f_digest, f_cut FROM public.mcpx_rw_hix_frozen_snapshots WHERE mint = c.mint AND window_start = c.window_start;
  IF f_digest IS DISTINCT FROM c.original_digest OR f_cut IS DISTINCT FROM c.cutoff_slot THEN RETURN 'REFUSED_FROZEN_DRIFT'; END IF;
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO open_ids FROM (SELECT id FROM public.mcpx_rw_hix_holds WHERE mint = c.mint AND window_start = c.window_start AND resolved_at IS NULL FOR UPDATE) h;
  IF open_ids = '{}' THEN RETURN 'REFUSED_NO_OPEN_HOLDS'; END IF;
  IF open_ids <> (SELECT array_agg(x ORDER BY x) FROM unnest(c.hold_ids) x) THEN RETURN 'REFUSED_STALE_CANDIDATE'; END IF;
  INSERT INTO public.mcpx_rw_hix_recovery_decisions (candidate_id, mint, window_start, decision, hold_ids, operator) VALUES (c.id, c.mint, c.window_start, 'RESOLVE_MATCH', open_ids, p_operator);
  UPDATE public.mcpx_rw_hix_holds SET resolved_at = now(), resolution = 'RECOVERY_MATCH:' || c.id::text WHERE id = ANY (open_ids);
  RETURN 'RESOLVED';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mcpx_rw_hix_recovery_candidates','mcpx_rw_hix_recovery_decisions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.mcpx_rw_hix_recovery_decisions_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.mcpx_rw_hix_resolve_window(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_hix_resolve_window(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.mcpx_rw_hix_holds_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcpx_rw_hix_recovery_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcpx_rw_hix_immutable() FROM PUBLIC;
