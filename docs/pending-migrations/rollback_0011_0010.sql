-- MCPX 05-I / 05-I.1 — LOCAL/PRE-DATA ROLLBACK ONLY. Destroys the objects added by 0011 and 0010.
-- Use only before any real (non-test) rows exist, and only with explicit operator approval. Once real frozen
-- snapshots exist, do NOT run this: the non-destructive strategy is to stop the worker and leave tables in place
-- (they are additive and unused by the website), marking them deprecated with COMMENT ON TABLE.
BEGIN;
DROP FUNCTION IF EXISTS public.mcpx_rw_hix_resolve_window(uuid, text);
DROP TABLE IF EXISTS public.mcpx_rw_hix_recovery_decisions;
DROP TABLE IF EXISTS public.mcpx_rw_hix_recovery_candidates;
DROP TRIGGER IF EXISTS mcpx_rw_hix_holds_guard ON public.mcpx_rw_hix_holds;
DROP INDEX IF EXISTS public.mcpx_rw_hix_holds_open;
DROP FUNCTION IF EXISTS public.mcpx_rw_hix_holds_guard();
DROP FUNCTION IF EXISTS public.mcpx_rw_hix_recovery_immutable();
DROP TABLE IF EXISTS public.mcpx_rw_hix_holds;
DROP TABLE IF EXISTS public.mcpx_rw_hix_frozen_owners;
DROP TABLE IF EXISTS public.mcpx_rw_hix_frozen_snapshots;
DROP TABLE IF EXISTS public.mcpx_rw_eligibility_policies;
DROP TABLE IF EXISTS public.mcpx_rw_hix_window_cutoffs;
DROP FUNCTION IF EXISTS public.mcpx_rw_hix_immutable();
COMMIT;
