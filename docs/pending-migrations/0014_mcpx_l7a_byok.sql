-- MCPX Phase L7-A: optional BYOK (bring-your-own-key) AI foundation. PENDING — NOT APPLIED.
-- Server-only. Stores AES-256-GCM ciphertext only (key-encryption key lives outside the DB as a server secret).
-- Additive: no existing table or column is changed. Products without AI keep working unchanged.
-- ROLLBACK (only while empty): DROP FUNCTION public.mcpx_ai_settle(uuid,text,integer,integer,bigint);
--   DROP FUNCTION public.mcpx_ai_admit(uuid,uuid,text,integer,integer); DROP FUNCTION public.mcpx_ai_revoke(uuid,text,integer);
--   DROP FUNCTION public.mcpx_ai_put_credential(uuid,text,text,text,bytea,bytea,text,text,text,text,integer);
--   DROP TABLE public.mcpx_ai_audit, public.mcpx_ai_usage, public.mcpx_ai_credentials, public.mcpx_ai_integrations;

CREATE TABLE public.mcpx_ai_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creation_id uuid NOT NULL UNIQUE REFERENCES public.mcp_creations (id) ON DELETE RESTRICT, -- one provider per product (MVP)
  creator_wallet text NOT NULL CHECK (creator_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  provider text NOT NULL CHECK (provider IN ('openai')),
  model text NOT NULL CHECK (model ~ '^[a-z0-9.-]{1,48}$'),
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','revoked')),
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency BETWEEN 1 AND 4),
  max_per_minute integer NOT NULL DEFAULT 6 CHECK (max_per_minute BETWEEN 1 AND 30),
  max_per_day integer NOT NULL DEFAULT 200 CHECK (max_per_day BETWEEN 1 AND 2000),
  max_input_tokens integer NOT NULL DEFAULT 4000 CHECK (max_input_tokens BETWEEN 256 AND 8000),
  max_output_tokens integer NOT NULL DEFAULT 600 CHECK (max_output_tokens BETWEEN 64 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (status <> 'revoked' OR (enabled = false AND revoked_at IS NOT NULL))
);

CREATE TABLE public.mcpx_ai_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES public.mcpx_ai_integrations (id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  alg text NOT NULL CHECK (alg = 'AES-256-GCM'),
  kek_version text NOT NULL CHECK (kek_version ~ '^v[0-9]{1,4}$'),
  iv bytea,
  ciphertext bytea,
  key_hint text NOT NULL CHECK (key_hint ~ '^[A-Za-z0-9_-]{4}$'), -- last 4 chars only
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','revoked')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (integration_id, version),
  UNIQUE (integration_id, idempotency_key),
  -- revoked/retired credentials are crypto-shredded: ciphertext removed, never recoverable
  CHECK ((status = 'active') = (ciphertext IS NOT NULL AND iv IS NOT NULL)),
  CHECK (ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 17 AND 1024),
  CHECK (iv IS NULL OR octet_length(iv) = 12)
);
CREATE UNIQUE INDEX mcpx_ai_credentials_one_active ON public.mcpx_ai_credentials (integration_id) WHERE status = 'active';

CREATE TABLE public.mcpx_ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES public.mcpx_ai_integrations (id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL REFERENCES public.mcpx_ai_credentials (id) ON DELETE RESTRICT,
  request_ref text NOT NULL CHECK (request_ref ~ '^[A-Za-z0-9_-]{16,64}$'),
  model text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','failed','ambiguous','expired')),
  reserved_input integer NOT NULL CHECK (reserved_input > 0),
  reserved_output integer NOT NULL CHECK (reserved_output > 0),
  used_input integer CHECK (used_input >= 0),
  used_output integer CHECK (used_output >= 0),
  est_cost_micros bigint CHECK (est_cost_micros >= 0),
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (integration_id, request_ref)
);
CREATE INDEX mcpx_ai_usage_window_idx ON public.mcpx_ai_usage (integration_id, created_at DESC);
CREATE INDEX mcpx_ai_usage_open_idx ON public.mcpx_ai_usage (integration_id) WHERE status = 'reserved';

CREATE TABLE public.mcpx_ai_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_id uuid NOT NULL REFERENCES public.mcpx_ai_integrations (id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('connect','replace','rotate','enable','pause','set_model_limits','revoke')),
  actor_ref text NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 96),
  revision integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcpx_ai_audit_idx ON public.mcpx_ai_audit (integration_id, at DESC);

-- Least privilege: nothing for public/browser roles; server role only.
REVOKE ALL ON public.mcpx_ai_integrations, public.mcpx_ai_credentials, public.mcpx_ai_usage, public.mcpx_ai_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mcpx_ai_integrations, public.mcpx_ai_usage TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.mcpx_ai_credentials TO service_role;
GRANT SELECT, INSERT ON public.mcpx_ai_audit TO service_role;
ALTER TABLE public.mcpx_ai_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcpx_ai_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcpx_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcpx_ai_audit ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies.

-- Connect / replace / rotate. Locks the integration row, so it serialises with revoke and admission.
-- Revoked integrations can never be revived by a replayed or racing rotate; only an explicit 'connect' after revoke
-- opens a fresh configuration (old credentials stay shredded). Returns 'ok' | 'replayed' | error code.
CREATE OR REPLACE FUNCTION public.mcpx_ai_put_credential(
  _creation uuid, _wallet text, _mode text, _provider text, _iv bytea, _ct bytea, _kek text, _hint text,
  _model text, _idem text, _expected_rev integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.mcpx_ai_integrations; v integer;
BEGIN
  IF _mode NOT IN ('connect','rotate') THEN RETURN 'invalid_mode'; END IF;
  SELECT * INTO i FROM public.mcpx_ai_integrations WHERE creation_id = _creation FOR UPDATE;
  IF FOUND AND i.creator_wallet <> _wallet THEN RETURN 'forbidden'; END IF;
  IF FOUND AND EXISTS (SELECT 1 FROM public.mcpx_ai_credentials WHERE integration_id = i.id AND idempotency_key = _idem) THEN RETURN 'replayed'; END IF;
  IF _mode = 'rotate' THEN
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF i.status = 'revoked' THEN RETURN 'revoked'; END IF;
    IF i.revision <> _expected_rev THEN RETURN 'stale_revision'; END IF;
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.mcpx_ai_integrations (creation_id, creator_wallet, provider, model) VALUES (_creation, _wallet, _provider, _model) RETURNING * INTO i;
  ELSE
    IF _mode = 'connect' AND i.status <> 'revoked' AND i.revision <> _expected_rev THEN RETURN 'stale_revision'; END IF;
    UPDATE public.mcpx_ai_credentials SET status = 'retired', iv = NULL, ciphertext = NULL, retired_at = now()
      WHERE integration_id = i.id AND status = 'active';
    UPDATE public.mcpx_ai_integrations SET provider = _provider, model = COALESCE(_model, model), status = 'configured',
      enabled = CASE WHEN status = 'revoked' THEN false ELSE enabled END, revoked_at = NULL,
      revision = revision + 1, updated_at = now() WHERE id = i.id RETURNING * INTO i;
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM public.mcpx_ai_credentials WHERE integration_id = i.id;
  INSERT INTO public.mcpx_ai_credentials (integration_id, version, alg, kek_version, iv, ciphertext, key_hint, idempotency_key)
    VALUES (i.id, v, 'AES-256-GCM', _kek, _iv, _ct, _hint, _idem);
  INSERT INTO public.mcpx_ai_audit (integration_id, action, actor_ref, revision)
    VALUES (i.id, CASE WHEN _mode = 'rotate' THEN 'rotate' WHEN v = 1 THEN 'connect' ELSE 'replace' END, 'wallet:' || _wallet, i.revision);
  RETURN 'ok';
END $$;

-- Revoke + remove: blocks every new admission at commit, shreds ciphertext. In-flight calls finish against
-- the decrypted key they already hold (bounded by the provider timeout) and still settle their usage row.
CREATE OR REPLACE FUNCTION public.mcpx_ai_revoke(_creation uuid, _wallet text, _expected_rev integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.mcpx_ai_integrations;
BEGIN
  SELECT * INTO i FROM public.mcpx_ai_integrations WHERE creation_id = _creation FOR UPDATE;
  IF NOT FOUND OR i.creator_wallet <> _wallet THEN RETURN 'not_found'; END IF;
  IF i.status = 'revoked' THEN RETURN 'replayed'; END IF;
  IF _expected_rev IS NOT NULL AND i.revision <> _expected_rev THEN RETURN 'stale_revision'; END IF;
  UPDATE public.mcpx_ai_credentials SET status = 'revoked', iv = NULL, ciphertext = NULL, retired_at = now()
    WHERE integration_id = i.id AND status = 'active';
  UPDATE public.mcpx_ai_integrations SET status = 'revoked', enabled = false, revoked_at = now(), revision = revision + 1, updated_at = now()
    WHERE id = i.id RETURNING * INTO i;
  INSERT INTO public.mcpx_ai_audit (integration_id, action, actor_ref, revision) VALUES (i.id, 'revoke', 'wallet:' || _wallet, i.revision);
  RETURN 'ok';
END $$;

-- Atomic admission. Returns 'admitted:<usage uuid>' or a denial code. Serialised per integration by the row lock.
-- Stale reservations (lease expired, process died) become 'ambiguous' and are charged at the reserved amount.
CREATE OR REPLACE FUNCTION public.mcpx_ai_admit(_creation uuid, _credential uuid, _ref text, _in integer, _out integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.mcpx_ai_integrations; c public.mcpx_ai_credentials; u uuid; lifecycle text;
BEGIN
  SELECT * INTO i FROM public.mcpx_ai_integrations WHERE creation_id = _creation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_configured'; END IF;
  IF i.status <> 'configured' THEN RETURN 'revoked'; END IF;
  IF NOT i.enabled THEN RETURN 'paused'; END IF;
  SELECT lifecycle_state INTO lifecycle FROM public.mcp_product_configs WHERE creation_id = _creation;
  IF lifecycle IS DISTINCT FROM 'active' THEN RETURN 'product_inactive'; END IF;
  SELECT * INTO c FROM public.mcpx_ai_credentials WHERE integration_id = i.id AND status = 'active';
  IF NOT FOUND OR c.id <> _credential THEN RETURN 'credential_changed'; END IF;
  IF _in < 1 OR _in > i.max_input_tokens OR _out < 1 OR _out > i.max_output_tokens THEN RETURN 'too_large'; END IF;
  IF EXISTS (SELECT 1 FROM public.mcpx_ai_usage WHERE integration_id = i.id AND request_ref = _ref) THEN RETURN 'duplicate'; END IF;
  UPDATE public.mcpx_ai_usage SET status = 'ambiguous', used_input = reserved_input, used_output = reserved_output, settled_at = now()
    WHERE integration_id = i.id AND status = 'reserved' AND lease_until < now();
  IF (SELECT count(*) FROM public.mcpx_ai_usage WHERE integration_id = i.id AND status = 'reserved') >= i.max_concurrency THEN RETURN 'busy'; END IF;
  IF (SELECT count(*) FROM public.mcpx_ai_usage WHERE integration_id = i.id AND created_at > now() - interval '1 minute') >= i.max_per_minute THEN RETURN 'rate_limited'; END IF;
  IF (SELECT count(*) FROM public.mcpx_ai_usage WHERE integration_id = i.id AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') >= i.max_per_day THEN RETURN 'daily_limit'; END IF;
  INSERT INTO public.mcpx_ai_usage (integration_id, credential_id, request_ref, model, reserved_input, reserved_output, lease_until)
    VALUES (i.id, c.id, _ref, i.model, _in, _out, now() + interval '60 seconds') RETURNING id INTO u;
  RETURN 'admitted:' || u::text;
END $$;

-- Settlement: exactly once; used tokens are clamped to the reservation so accounting is always bounded.
CREATE OR REPLACE FUNCTION public.mcpx_ai_settle(_usage uuid, _status text, _in integer, _out integer, _cost bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _status NOT IN ('settled','failed','ambiguous') THEN RETURN false; END IF;
  UPDATE public.mcpx_ai_usage SET status = _status,
    used_input = CASE WHEN _status = 'ambiguous' THEN reserved_input ELSE LEAST(GREATEST(COALESCE(_in, 0), 0), reserved_input) END,
    used_output = CASE WHEN _status = 'ambiguous' THEN reserved_output ELSE LEAST(GREATEST(COALESCE(_out, 0), 0), reserved_output) END,
    est_cost_micros = GREATEST(COALESCE(_cost, 0), 0), settled_at = now()
  WHERE id = _usage AND status = 'reserved';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.mcpx_ai_put_credential(uuid,text,text,text,bytea,bytea,text,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_ai_revoke(uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_ai_admit(uuid,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_ai_settle(uuid,text,integer,integer,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_ai_put_credential(uuid,text,text,text,bytea,bytea,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_ai_revoke(uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_ai_admit(uuid,uuid,text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_ai_settle(uuid,text,integer,integer,bigint) TO service_role;
