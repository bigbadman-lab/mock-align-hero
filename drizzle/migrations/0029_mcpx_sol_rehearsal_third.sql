ALTER TABLE public.mcpx_sol_rehearsal DROP CONSTRAINT mcpx_sol_rehearsal_id_check;
ALTER TABLE public.mcpx_sol_rehearsal ADD CONSTRAINT mcpx_sol_rehearsal_id_check CHECK (id IN (1, 2, 3));

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_grant(_wallet text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int; last record;
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  LOCK TABLE mcpx_sol_rehearsal IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM mcpx_sol_rehearsal;
  IF n = 0 THEN
    INSERT INTO mcpx_sol_rehearsal (id, creator_wallet) VALUES (1, _wallet);
  ELSIF n IN (1, 2) THEN
    SELECT * INTO last FROM mcpx_sol_rehearsal WHERE id = n;
    IF last.status <> 'CONSUMED' OR last.creator_wallet <> _wallet THEN RETURN 'already_granted'; END IF;
    INSERT INTO mcpx_sol_rehearsal (id, creator_wallet) VALUES (n + 1, _wallet);
  ELSE
    RETURN 'already_granted';
  END IF;
  PERFORM mcpx_sol_rehearsal_log('grant', NULL, 'AVAILABLE', NULL, NULL,
    CASE WHEN n = 1 THEN 'SECOND_REHEARSAL' WHEN n = 2 THEN 'THIRD_REHEARSAL' END);
  RETURN 'granted';
END $$;

REVOKE ALL ON FUNCTION public.mcpx_sol_rehearsal_grant(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_sol_rehearsal_grant(text) TO service_role;