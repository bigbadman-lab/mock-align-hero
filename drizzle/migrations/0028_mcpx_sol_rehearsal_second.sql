-- SOL-REHEARSAL #2. Additive; row 1 (first rehearsal, CONSUMED) never changes.
-- Allows exactly ONE more single-use permission (id = 2), grantable only after row 1 is CONSUMED, with the same
-- lifecycle and guards as 0027. All functions act on the newest permission row; register looks up by mint so the
-- first rehearsal's records stay intact. No third permission can ever exist.

ALTER TABLE public.mcpx_sol_rehearsal DROP CONSTRAINT mcpx_sol_rehearsal_id_check;
ALTER TABLE public.mcpx_sol_rehearsal ADD CONSTRAINT mcpx_sol_rehearsal_id_check CHECK (id IN (1, 2));
ALTER TABLE public.mcpx_sol_rehearsal ALTER COLUMN id DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_current() RETURNS smallint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT max(id) FROM mcpx_sol_rehearsal $$;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_grant(_wallet text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int; last record;
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  LOCK TABLE mcpx_sol_rehearsal IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM mcpx_sol_rehearsal;
  IF n = 0 THEN
    INSERT INTO mcpx_sol_rehearsal (id, creator_wallet) VALUES (1, _wallet);
  ELSIF n = 1 THEN
    SELECT * INTO last FROM mcpx_sol_rehearsal WHERE id = 1;
    IF last.status <> 'CONSUMED' OR last.creator_wallet <> _wallet THEN RETURN 'already_granted'; END IF;
    INSERT INTO mcpx_sol_rehearsal (id, creator_wallet) VALUES (2, _wallet);
  ELSE
    RETURN 'already_granted';
  END IF;
  PERFORM mcpx_sol_rehearsal_log('grant', NULL, 'AVAILABLE', NULL, NULL, CASE WHEN n = 1 THEN 'SECOND_REHEARSAL' END);
  RETURN 'granted';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_reserve(_wallet text, _draft uuid, _mint text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; i smallint := mcpx_sol_rehearsal_current();
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = i FOR UPDATE;
  IF NOT FOUND OR r.creator_wallet <> _wallet THEN RETURN 'not_permitted'; END IF;
  IF r.status IN ('CONSUMED', 'REVOKED') THEN RETURN 'used'; END IF;
  IF r.status <> 'AVAILABLE' THEN
    RETURN CASE WHEN r.draft_id = _draft AND r.mint = _mint AND r.status = 'RESERVED' THEN 'already_reserved' ELSE 'busy' END;
  END IF;
  UPDATE mcpx_sol_rehearsal SET status = 'RESERVED', draft_id = _draft, mint = _mint, reserved_at = now() WHERE id = i;
  PERFORM mcpx_sol_rehearsal_log('reserve', 'AVAILABLE', 'RESERVED', _mint, NULL, NULL);
  RETURN 'reserved';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_submit(_wallet text, _mint text, _sig text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; i smallint := mcpx_sol_rehearsal_current();
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = i FOR UPDATE;
  IF NOT FOUND OR r.creator_wallet <> _wallet OR r.mint IS DISTINCT FROM _mint THEN RETURN 'mismatch'; END IF;
  IF r.status = 'SUBMITTED' THEN RETURN CASE WHEN r.signature = _sig THEN 'already_submitted' ELSE 'mismatch' END; END IF;
  IF r.status <> 'RESERVED' THEN RETURN 'mismatch'; END IF;
  UPDATE mcpx_sol_rehearsal SET status = 'SUBMITTED', signature = _sig WHERE id = i;
  PERFORM mcpx_sol_rehearsal_log('submit', 'RESERVED', 'SUBMITTED', _mint, _sig, NULL);
  RETURN 'submitted';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_consume(_creation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; c record;
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO c FROM mcp_creations WHERE id = _creation FOR UPDATE;
  IF c IS NULL THEN RETURN 'mismatch'; END IF;
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE mint = c.child_mint FOR UPDATE;
  IF r IS NULL THEN RETURN 'mismatch'; END IF;
  IF r.status = 'CONSUMED' THEN RETURN CASE WHEN r.creation_id = _creation THEN 'already_consumed' ELSE 'mismatch' END; END IF;
  IF r.status <> 'SUBMITTED' OR c.verified_tx_signature <> r.signature OR c.creator_wallet <> r.creator_wallet
     OR c.quote_mint <> 'So11111111111111111111111111111111111111112' THEN RETURN 'mismatch'; END IF;
  UPDATE mcp_creations SET pair_kind = 'SOL_REHEARSAL' WHERE id = _creation;
  UPDATE mcpx_sol_rehearsal SET status = 'CONSUMED', creation_id = _creation WHERE id = r.id;
  PERFORM mcpx_sol_rehearsal_log('consume', 'SUBMITTED', 'CONSUMED', r.mint, r.signature, NULL);
  RETURN 'consumed';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_release(_reason text, _revoke boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; i smallint := mcpx_sol_rehearsal_current();
BEGIN
  IF _reason IS NULL OR _reason !~ '^[A-Z0-9_]{1,64}$' THEN RETURN 'reason_required'; END IF;
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = i FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_granted'; END IF;
  IF r.status IN ('CONSUMED', 'REVOKED') THEN RETURN 'final'; END IF;
  IF _revoke THEN
    UPDATE mcpx_sol_rehearsal SET status = 'REVOKED' WHERE id = i;
    PERFORM mcpx_sol_rehearsal_log('revoke', r.status, 'REVOKED', r.mint, r.signature, _reason);
    RETURN 'revoked';
  END IF;
  IF r.status = 'AVAILABLE' THEN RETURN 'nothing_to_release'; END IF;
  IF r.status = 'SUBMITTED' THEN RETURN 'submitted_revoke_only'; END IF;
  UPDATE mcpx_sol_rehearsal SET status = 'AVAILABLE', draft_id = NULL, mint = NULL, signature = NULL, reserved_at = NULL WHERE id = i;
  PERFORM mcpx_sol_rehearsal_log('release', r.status, 'AVAILABLE', r.mint, r.signature, _reason);
  RETURN 'released';
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_cf_rehearsal_permission()
RETURNS TABLE (creator_wallet text, status text, mint text, signature text, creation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT creator_wallet, status, mint, signature, creation_id FROM mcpx_sol_rehearsal WHERE id = mcpx_sol_rehearsal_current();
$$;

CREATE OR REPLACE FUNCTION public.mcpx_cf_register_rehearsal(_claim uuid, _slot bigint, _evidence_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; c record; res text; cid uuid; k text;
BEGIN
  SELECT * INTO c FROM mcpx_cf_launch_claims WHERE id = _claim FOR UPDATE;
  IF c IS NULL THEN RETURN 'not_rehearsal'; END IF;
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE mint = c.mint FOR UPDATE;
  IF r IS NULL OR c.signature IS DISTINCT FROM r.signature
     OR c.creator_wallet <> r.creator_wallet OR c.draft_id IS DISTINCT FROM r.draft_id THEN RETURN 'not_rehearsal'; END IF;
  IF r.status = 'CONSUMED' THEN
    RETURN CASE WHEN c.status = 'VERIFIED' AND c.creation_id = r.creation_id THEN 'already_verified:' || r.creation_id ELSE 'not_rehearsal' END;
  END IF;
  IF r.status <> 'SUBMITTED' THEN RETURN 'permission_not_submitted'; END IF;
  res := mcpx_cf_register_launch(_claim, _slot, 'So11111111111111111111111111111111111111112', _evidence_id);
  IF res NOT LIKE 'registered:%' AND res NOT LIKE 'already_verified:%' THEN RETURN res; END IF;
  cid := split_part(res, ':', 2)::uuid;
  k := mcpx_sol_rehearsal_consume(cid);
  IF k NOT IN ('consumed', 'already_consumed') THEN RAISE EXCEPTION 'rehearsal_consume_failed:%', k; END IF;
  RETURN res;
END $$;

REVOKE ALL ON FUNCTION public.mcpx_sol_rehearsal_current() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_sol_rehearsal_current() TO service_role;
REVOKE ALL ON FUNCTION public.mcpx_sol_rehearsal_grant(text), public.mcpx_sol_rehearsal_reserve(text, uuid, text),
  public.mcpx_sol_rehearsal_submit(text, text, text), public.mcpx_sol_rehearsal_consume(uuid), public.mcpx_sol_rehearsal_release(text, boolean),
  public.mcpx_cf_rehearsal_permission(), public.mcpx_cf_register_rehearsal(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_sol_rehearsal_grant(text), public.mcpx_sol_rehearsal_reserve(text, uuid, text),
  public.mcpx_sol_rehearsal_submit(text, text, text), public.mcpx_sol_rehearsal_consume(uuid), public.mcpx_sol_rehearsal_release(text, boolean),
  public.mcpx_cf_rehearsal_permission(), public.mcpx_cf_register_rehearsal(uuid, bigint, text) TO service_role;
