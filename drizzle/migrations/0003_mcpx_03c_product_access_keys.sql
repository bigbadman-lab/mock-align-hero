-- MCPX Phase 03-C: product-scoped access keys + audit. Server-only; starts empty. Only keyed verifiers stored, never key plaintext.
-- ROLLBACK: DROP FUNCTION public.mcpx_issue_product_key(uuid,text,text,timestamptz,text,text,text,text,uuid); DROP FUNCTION public.mcpx_revoke_product_key(uuid,uuid,text,text); DROP TABLE public.mcp_product_key_events; DROP TABLE public.mcp_product_access_keys;
CREATE TABLE public.mcp_product_access_keys (
  key_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creation_id uuid NOT NULL REFERENCES public.mcp_product_configs (creation_id) ON DELETE RESTRICT,
  verifier text NOT NULL UNIQUE CHECK (verifier ~ '^[0-9a-f]{64}$'),
  display_prefix text NOT NULL CHECK (display_prefix ~ '^mcpx_pk_[A-Za-z0-9_-]{4}$'),
  scope text NOT NULL DEFAULT 'product:tools.call' CHECK (scope = 'product:tools.call'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  label text CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 64 AND label !~ '[<>]')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('operator','creator')),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[A-Za-z0-9:_-]{1,96}$'),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  rotated_from uuid REFERENCES public.mcp_product_access_keys (key_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX mcp_product_access_keys_creation_idx ON public.mcp_product_access_keys (creation_id, status);
REVOKE ALL ON public.mcp_product_access_keys FROM anon, authenticated;
GRANT ALL ON public.mcp_product_access_keys TO service_role;
ALTER TABLE public.mcp_product_access_keys ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.mcp_product_key_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES public.mcp_product_access_keys (key_id) ON DELETE RESTRICT,
  creation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('issued','revoked','rotated')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('operator','creator')),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[A-Za-z0-9:_-]{1,96}$'),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,32}$'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.mcp_product_key_events FROM anon, authenticated;
GRANT ALL ON public.mcp_product_key_events TO service_role;
ALTER TABLE public.mcp_product_key_events ENABLE ROW LEVEL SECURITY;
-- No policies on either table: browsers have no access.

-- Key rows: only status/revoked_at/last_used_at may change.
CREATE OR REPLACE FUNCTION public.mcpx_key_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.key_id <> OLD.key_id OR NEW.creation_id <> OLD.creation_id OR NEW.verifier <> OLD.verifier OR NEW.scope <> OLD.scope
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'access key identity fields are immutable';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN RAISE EXCEPTION 'revocation is permanent'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mcp_product_access_keys_guard BEFORE UPDATE ON public.mcp_product_access_keys FOR EACH ROW EXECUTE FUNCTION public.mcpx_key_guard();

-- Atomic issue (optionally rotating one prior key of the SAME product). Idempotent on idempotency_key.
CREATE OR REPLACE FUNCTION public.mcpx_issue_product_key(
  _creation_id uuid, _verifier text, _display_prefix text, _expires_at timestamptz, _label text,
  _actor_kind text, _actor_ref text, _idempotency_key text, _rotate_key_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k uuid; prior record;
BEGIN
  SELECT key_id INTO k FROM mcp_product_access_keys WHERE idempotency_key = _idempotency_key AND creation_id = _creation_id;
  IF k IS NOT NULL THEN RETURN k; END IF;
  IF NOT EXISTS (SELECT 1 FROM mcp_product_configs p JOIN mcp_creations c ON c.id = p.creation_id AND c.template_id = p.template_id
                 WHERE p.creation_id = _creation_id) THEN
    RAISE EXCEPTION 'no verified product';
  END IF;
  IF _rotate_key_id IS NOT NULL THEN
    SELECT * INTO prior FROM mcp_product_access_keys WHERE key_id = _rotate_key_id FOR UPDATE;
    IF prior IS NULL OR prior.creation_id <> _creation_id OR prior.status <> 'active' THEN RAISE EXCEPTION 'rotation target invalid'; END IF;
  END IF;
  INSERT INTO mcp_product_access_keys (creation_id, verifier, display_prefix, expires_at, label, actor_kind, actor_ref, idempotency_key, rotated_from)
  VALUES (_creation_id, _verifier, _display_prefix, _expires_at, _label, _actor_kind, _actor_ref, _idempotency_key, _rotate_key_id)
  RETURNING key_id INTO k;
  INSERT INTO mcp_product_key_events (key_id, creation_id, event_type, actor_kind, actor_ref)
  VALUES (k, _creation_id, CASE WHEN _rotate_key_id IS NULL THEN 'issued' ELSE 'rotated' END, _actor_kind, _actor_ref);
  IF _rotate_key_id IS NOT NULL THEN
    UPDATE mcp_product_access_keys SET status = 'revoked', revoked_at = now() WHERE key_id = _rotate_key_id;
    INSERT INTO mcp_product_key_events (key_id, creation_id, event_type, actor_kind, actor_ref, reason)
    VALUES (_rotate_key_id, _creation_id, 'revoked', _actor_kind, _actor_ref, 'rotated');
  END IF;
  RETURN k;
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_revoke_product_key(_creation_id uuid, _key_id uuid, _actor_kind text, _actor_ref text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE mcp_product_access_keys SET status = 'revoked', revoked_at = now()
  WHERE key_id = _key_id AND creation_id = _creation_id AND status = 'active';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO mcp_product_key_events (key_id, creation_id, event_type, actor_kind, actor_ref, reason)
  VALUES (_key_id, _creation_id, 'revoked', _actor_kind, _actor_ref, 'requested');
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.mcpx_issue_product_key(uuid,text,text,timestamptz,text,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_revoke_product_key(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_issue_product_key(uuid,text,text,timestamptz,text,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_revoke_product_key(uuid,uuid,text,text) TO service_role;