-- MCPX Phase 05-I — PENDING. NOT applied to production. Requires explicit operator approval before applying.
-- Adds: window→finalized cutoff evidence, frozen per-window holder snapshots (immutable), repair holds,
-- versioned eligibility policies. Service-role only; no browser access. Additive only.
CREATE TABLE public.mcpx_rw_hix_window_cutoffs (
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('SELECTED','ON_HOLD')),
  cutoff_slot bigint,
  cutoff_block_time timestamptz,
  next_slot bigint,
  next_block_time timestamptz,
  finalized_head bigint,
  finalized_head_time timestamptz,
  selection_method text NOT NULL,
  hold_reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, window_start),
  CHECK (window_end = window_start + interval '300 seconds'),
  CHECK (extract(epoch from window_start)::bigint % 300 = 0),
  CHECK (status <> 'SELECTED' OR (cutoff_slot IS NOT NULL AND next_slot > cutoff_slot AND cutoff_block_time < window_end AND next_block_time >= window_end))
);
CREATE TABLE public.mcpx_rw_eligibility_policies (
  version text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('DRAFT','TEST_FIXTURE','APPROVED_FOR_LIVE_PAYOUTS')),
  effective_from_window timestamptz NOT NULL,
  body jsonb NOT NULL,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'TEST_FIXTURE' OR version LIKE 'test-%'),
  CHECK (status <> 'APPROVED_FOR_LIVE_PAYOUTS' OR (approved_by IS NOT NULL AND version NOT LIKE 'test-%'))
);
CREATE TABLE public.mcpx_rw_hix_frozen_snapshots (
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  cutoff_slot bigint NOT NULL,
  checkpoint_slot bigint NOT NULL CHECK (checkpoint_slot >= cutoff_slot),
  policy_version text NOT NULL REFERENCES public.mcpx_rw_eligibility_policies(version),
  supply_at_cutoff numeric(20,0) NOT NULL,
  indexed_total numeric(20,0) NOT NULL CHECK (indexed_total = supply_at_cutoff),
  supply_proof jsonb NOT NULL,
  eligible_total numeric(20,0) NOT NULL,
  excluded_total numeric(20,0) NOT NULL,
  ambiguous_total numeric(20,0) NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('COMPLETE','COMPLETE_AMBIGUOUS_HELD')),
  digest text NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, window_start),
  FOREIGN KEY (mint, window_start) REFERENCES public.mcpx_rw_hix_window_cutoffs(mint, window_start),
  CHECK (eligible_total + excluded_total + ambiguous_total = supply_at_cutoff)
);
CREATE TABLE public.mcpx_rw_hix_frozen_owners (
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  owner text NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  class text NOT NULL CHECK (class IN ('ELIGIBLE','EXCLUDED','AMBIGUOUS')),
  reason text,
  PRIMARY KEY (mint, window_start, owner),
  FOREIGN KEY (mint, window_start) REFERENCES public.mcpx_rw_hix_frozen_snapshots(mint, window_start)
);
CREATE TABLE public.mcpx_rw_hix_holds (
  id bigserial PRIMARY KEY,
  mint text NOT NULL,
  window_start timestamptz NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text,
  UNIQUE (mint, window_start, reason)
);
-- Immutability: selected cutoffs, policies, frozen snapshots and owners can never be updated or deleted.
CREATE OR REPLACE FUNCTION public.mcpx_rw_hix_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'mcpx_rw_hix_window_cutoffs' AND TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD)->>'status' = 'ON_HOLD' THEN RETURN NEW; END IF; -- only a held window may later be selected
  END IF;
  RAISE EXCEPTION 'mcpx_rw immutable row in %', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER mcpx_rw_hix_cutoffs_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_hix_window_cutoffs FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_immutable();
CREATE TRIGGER mcpx_rw_policies_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_eligibility_policies FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_immutable();
CREATE TRIGGER mcpx_rw_frozen_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_hix_frozen_snapshots FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_immutable();
CREATE TRIGGER mcpx_rw_frozen_owners_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_hix_frozen_owners FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_hix_immutable();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mcpx_rw_hix_window_cutoffs','mcpx_rw_eligibility_policies','mcpx_rw_hix_frozen_snapshots','mcpx_rw_hix_frozen_owners','mcpx_rw_hix_holds'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.mcpx_rw_hix_holds_id_seq TO service_role;