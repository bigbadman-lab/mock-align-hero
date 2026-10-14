-- SOL-REHEARSAL (pending; NOT applied to production). Additive only; no existing rows change.
-- One-use permission for exactly one SOL-paired child launch before the official $MCP mint exists, plus an
-- explicit marker on the resulting product so it can be excluded from native $MCP accounting.
-- Lifecycle: AVAILABLE → RESERVED (mint bound, before signing) → SUBMITTED (signature bound, before broadcast)
--            → CONSUMED (verifier registered the product). Recovery: RESERVED/SUBMITTED → AVAILABLE only through
--            mcpx_sol_rehearsal_release with a reason code, audited; never automatic.
-- Server-only: browser roles have no access to either table or any function.

ALTER TABLE public.mcp_creations ADD COLUMN pair_kind text NOT NULL DEFAULT 'MCP' CHECK (pair_kind IN ('MCP', 'SOL_REHEARSAL'));
GRANT SELECT (pair_kind) ON public.mcp_creations TO anon, authenticated;

CREATE TABLE public.mcpx_sol_rehearsal (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- exactly one permission can ever exist
  creator_wallet text NOT NULL CHECK (creator_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'RESERVED', 'SUBMITTED', 'CONSUMED', 'REVOKED')),
  draft_id uuid REFERENCES public.mcpx_launch_drafts(id),
  mint text CHECK (mint IS NULL OR mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signature text CHECK (signature IS NULL OR signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  creation_id uuid REFERENCES public.mcp_creations(id),
  reserved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'AVAILABLE') = (mint IS NULL AND draft_id IS NULL) OR status = 'REVOKED'),
  CHECK ((status IN ('SUBMITTED', 'CONSUMED')) <= (signature IS NOT NULL)),
  CHECK ((status = 'CONSUMED') = (creation_id IS NOT NULL))
);
GRANT ALL ON public.mcpx_sol_rehearsal TO service_role;
REVOKE ALL ON public.mcpx_sol_rehearsal FROM anon, authenticated;
ALTER TABLE public.mcpx_sol_rehearsal ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.mcpx_sol_rehearsal_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event ~ '^[a-z_]{1,32}$'),
  from_status text, to_status text,
  mint text, signature text,
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z0-9_]{1,64}$'),
  at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.mcpx_sol_rehearsal_events TO service_role;
REVOKE ALL ON public.mcpx_sol_rehearsal_events FROM anon, authenticated;
ALTER TABLE public.mcpx_sol_rehearsal_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'rehearsal audit is append-only'; END $$;
CREATE TRIGGER mcpx_sol_rehearsal_events_guard BEFORE UPDATE OR DELETE ON public.mcpx_sol_rehearsal_events
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_sol_rehearsal_events_guard();

-- Direct writes are refused: every transition goes through the functions below (which set this flag).
CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('mcpx.rehearsal_fn', true), '') <> '1' THEN RAISE EXCEPTION 'rehearsal permission changes only through its functions'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'rehearsal permission is permanent'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('CONSUMED', 'REVOKED') THEN RAISE EXCEPTION 'rehearsal permission is final'; END IF;
    IF NEW.creator_wallet <> OLD.creator_wallet THEN RAISE EXCEPTION 'rehearsal creator is immutable'; END IF;
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mcpx_sol_rehearsal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mcpx_sol_rehearsal
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_sol_rehearsal_guard();

CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_log(_e text, _from text, _to text, _mint text, _sig text, _reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO mcpx_sol_rehearsal_events (event, from_status, to_status, mint, signature, reason) VALUES (_e, _from, _to, _mint, _sig, _reason);
$$;

-- Operator: grant the single permission (refused if one has ever existed).
CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_grant(_wallet text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  IF EXISTS (SELECT 1 FROM mcpx_sol_rehearsal) THEN RETURN 'already_granted'; END IF;
  INSERT INTO mcpx_sol_rehearsal (creator_wallet) VALUES (_wallet);
  PERFORM mcpx_sol_rehearsal_log('grant', NULL, 'AVAILABLE', NULL, NULL, NULL);
  RETURN 'granted';
END $$;

-- Before signing: bind wallet + draft + mint. Same (draft, mint) again is an idempotent retry.
-- Returns reserved | already_reserved | not_permitted | busy | used.
CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_reserve(_wallet text, _draft uuid, _mint text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR r.creator_wallet <> _wallet THEN RETURN 'not_permitted'; END IF;
  IF r.status IN ('CONSUMED', 'REVOKED') THEN RETURN 'used'; END IF;
  IF r.status <> 'AVAILABLE' THEN
    RETURN CASE WHEN r.draft_id = _draft AND r.mint = _mint AND r.status = 'RESERVED' THEN 'already_reserved' ELSE 'busy' END;
  END IF;
  UPDATE mcpx_sol_rehearsal SET status = 'RESERVED', draft_id = _draft, mint = _mint, reserved_at = now() WHERE id = 1;
  PERFORM mcpx_sol_rehearsal_log('reserve', 'AVAILABLE', 'RESERVED', _mint, NULL, NULL);
  RETURN 'reserved';
END $$;

-- Immediately before broadcast: bind the signed transaction's signature. Returns submitted | already_submitted | mismatch.
CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_submit(_wallet text, _mint text, _sig text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR r.creator_wallet <> _wallet OR r.mint IS DISTINCT FROM _mint THEN RETURN 'mismatch'; END IF;
  IF r.status = 'SUBMITTED' THEN RETURN CASE WHEN r.signature = _sig THEN 'already_submitted' ELSE 'mismatch' END; END IF;
  IF r.status <> 'RESERVED' THEN RETURN 'mismatch'; END IF;
  UPDATE mcpx_sol_rehearsal SET status = 'SUBMITTED', signature = _sig WHERE id = 1;
  PERFORM mcpx_sol_rehearsal_log('submit', 'RESERVED', 'SUBMITTED', _mint, _sig, NULL);
  RETURN 'submitted';
END $$;

-- Verifier, after independent on-chain confirmation and product registration: consume + mark the product.
-- Returns consumed | already_consumed | mismatch.
CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_consume(_creation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; c record;
BEGIN
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = 1 FOR UPDATE;
  SELECT * INTO c FROM mcp_creations WHERE id = _creation FOR UPDATE;
  IF r IS NULL OR c IS NULL THEN RETURN 'mismatch'; END IF;
  IF r.status = 'CONSUMED' THEN RETURN CASE WHEN r.creation_id = _creation THEN 'already_consumed' ELSE 'mismatch' END; END IF;
  IF r.status <> 'SUBMITTED' OR c.child_mint <> r.mint OR c.verified_tx_signature <> r.signature OR c.creator_wallet <> r.creator_wallet
     OR c.quote_mint <> 'So11111111111111111111111111111111111111112' THEN RETURN 'mismatch'; END IF;
  UPDATE mcp_creations SET pair_kind = 'SOL_REHEARSAL' WHERE id = _creation;
  UPDATE mcpx_sol_rehearsal SET status = 'CONSUMED', creation_id = _creation WHERE id = 1;
  PERFORM mcpx_sol_rehearsal_log('consume', 'SUBMITTED', 'CONSUMED', r.mint, r.signature, NULL);
  RETURN 'consumed';
END $$;

-- Operator recovery for a failed/expired attempt: back to AVAILABLE with an audited reason. Never automatic,
-- never from CONSUMED/REVOKED. _revoke = true closes the permission for good instead.
CREATE OR REPLACE FUNCTION public.mcpx_sol_rehearsal_release(_reason text, _revoke boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF _reason IS NULL OR _reason !~ '^[A-Z0-9_]{1,64}$' THEN RETURN 'reason_required'; END IF;
  PERFORM set_config('mcpx.rehearsal_fn', '1', true);
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_granted'; END IF;
  IF r.status IN ('CONSUMED', 'REVOKED') THEN RETURN 'final'; END IF;
  IF _revoke THEN
    UPDATE mcpx_sol_rehearsal SET status = 'REVOKED' WHERE id = 1;
    PERFORM mcpx_sol_rehearsal_log('revoke', r.status, 'REVOKED', r.mint, r.signature, _reason);
    RETURN 'revoked';
  END IF;
  IF r.status = 'AVAILABLE' THEN RETURN 'nothing_to_release'; END IF;
  -- Once a signed creation may have been broadcast, re-opening the permission could allow a second token.
  IF r.status = 'SUBMITTED' THEN RETURN 'submitted_revoke_only'; END IF;
  UPDATE mcpx_sol_rehearsal SET status = 'AVAILABLE', draft_id = NULL, mint = NULL, signature = NULL, reserved_at = NULL WHERE id = 1;
  PERFORM mcpx_sol_rehearsal_log('release', r.status, 'AVAILABLE', r.mint, r.signature, _reason);
  RETURN 'released';
END $$;

REVOKE ALL ON FUNCTION public.mcpx_sol_rehearsal_log(text, text, text, text, text, text), public.mcpx_sol_rehearsal_grant(text),
  public.mcpx_sol_rehearsal_reserve(text, uuid, text), public.mcpx_sol_rehearsal_submit(text, text, text),
  public.mcpx_sol_rehearsal_consume(uuid), public.mcpx_sol_rehearsal_release(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_sol_rehearsal_grant(text), public.mcpx_sol_rehearsal_reserve(text, uuid, text),
  public.mcpx_sol_rehearsal_submit(text, text, text), public.mcpx_sol_rehearsal_consume(uuid), public.mcpx_sol_rehearsal_release(text, boolean) TO service_role;

-- PART 4 (Worker #3). Exposed through mcpx_cf_* names so the sealed worker bridge guard (public.mcpx_cf_* only) allows them.
-- Read-only view of the permission for the launch checker (no browser access).
CREATE OR REPLACE FUNCTION public.mcpx_cf_rehearsal_permission()
RETURNS TABLE (creator_wallet text, status text, mint text, signature text, creation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT creator_wallet, status, mint, signature, creation_id FROM mcpx_sol_rehearsal WHERE id = 1;
$$;

-- After the worker's independent finalized on-chain verification of the SOL rehearsal launch: register the product
-- through the existing mcpx_cf_register_launch, then consume the permission + mark pair_kind — all in ONE transaction,
-- so a confirmed token is never left registered-but-unconsumed. Idempotent. Returns
-- 'registered:<id>' | 'already_verified:<id>' | 'not_rehearsal' | 'permission_not_submitted' | <register_launch refusal>.
CREATE OR REPLACE FUNCTION public.mcpx_cf_register_rehearsal(_claim uuid, _slot bigint, _evidence_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; c record; res text; cid uuid; k text;
BEGIN
  SELECT * INTO r FROM mcpx_sol_rehearsal WHERE id = 1 FOR UPDATE;
  SELECT * INTO c FROM mcpx_cf_launch_claims WHERE id = _claim FOR UPDATE;
  IF r IS NULL OR c IS NULL OR c.mint IS DISTINCT FROM r.mint OR c.signature IS DISTINCT FROM r.signature
     OR c.creator_wallet <> r.creator_wallet OR c.draft_id IS DISTINCT FROM r.draft_id THEN RETURN 'not_rehearsal'; END IF;
  IF r.status = 'CONSUMED' THEN
    RETURN CASE WHEN c.status = 'VERIFIED' AND c.creation_id = r.creation_id THEN 'already_verified:' || r.creation_id ELSE 'not_rehearsal' END;
  END IF;
  IF r.status <> 'SUBMITTED' THEN RETURN 'permission_not_submitted'; END IF;
  res := mcpx_cf_register_launch(_claim, _slot, 'So11111111111111111111111111111111111111112', _evidence_id);
  IF res NOT LIKE 'registered:%' AND res NOT LIKE 'already_verified:%' THEN RETURN res; END IF; -- nothing written
  cid := split_part(res, ':', 2)::uuid;
  k := mcpx_sol_rehearsal_consume(cid);
  IF k NOT IN ('consumed', 'already_consumed') THEN RAISE EXCEPTION 'rehearsal_consume_failed:%', k; END IF; -- rolls back registration
  RETURN res;
END $$;

REVOKE ALL ON FUNCTION public.mcpx_cf_rehearsal_permission(), public.mcpx_cf_register_rehearsal(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_cf_rehearsal_permission(), public.mcpx_cf_register_rehearsal(uuid, bigint, text) TO service_role;
