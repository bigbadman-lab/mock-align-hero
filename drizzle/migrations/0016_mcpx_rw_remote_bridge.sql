-- Rewards worker writes through the site (Option 1). Service-role only; no browser access.
CREATE TABLE public.mcpx_rw_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mint text,
  deployer_wallet text,
  anchor_slot bigint,
  genesis_window bigint CHECK (genesis_window IS NULL OR genesis_window % 300 = 0),
  emergency_stop boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.mcpx_rw_config TO service_role;
REVOKE ALL ON public.mcpx_rw_config FROM anon, authenticated;
ALTER TABLE public.mcpx_rw_config ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.mcpx_rw_remote_nonces (
  nonce text PRIMARY KEY,
  seen_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.mcpx_rw_remote_nonces TO service_role;
REVOKE ALL ON public.mcpx_rw_remote_nonces FROM anon, authenticated;
ALTER TABLE public.mcpx_rw_remote_nonces ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mcpx_rw_remote_nonce_take(p_nonce text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM public.mcpx_rw_remote_nonces WHERE seen_at < now() - interval '1 hour';
  INSERT INTO public.mcpx_rw_remote_nonces (nonce) VALUES (p_nonce) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_rw_remote_nonce_take(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_remote_nonce_take(text) TO service_role;

-- Numbers come back as text so 64-bit amounts never lose precision in JSON.
CREATE OR REPLACE FUNCTION public.mcpx_rw_row_text(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(key, CASE WHEN jsonb_typeof(value) = 'number' THEN to_jsonb(value #>> '{}') ELSE value END), '{}'::jsonb)
  FROM jsonb_each(r)
$$;
REVOKE ALL ON FUNCTION public.mcpx_rw_row_text(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_row_text(jsonb) TO service_role;

-- Executes a site-validated, already-bound statement batch in ONE transaction (the function call).
-- p_steps: [{q: sql, r: returns_rows, a: abort_code|null}]. search_path is pinned so only schema-qualified
-- public.mcpx_rw_* names (enforced by the site) resolve to tables.
CREATE OR REPLACE FUNCTION public.mcpx_rw_remote_exec(p_steps jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp SET statement_timeout = '25s' AS $$
DECLARE st jsonb; q text; rows jsonb; n bigint; out jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) = 0 OR jsonb_array_length(p_steps) > 20000 THEN
    RAISE EXCEPTION 'MCPX_BAD_BATCH';
  END IF;
  FOR st IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
    q := st->>'q';
    IF q IS NULL OR q !~* '^\s*(select|insert|update|delete|with)\s' THEN RAISE EXCEPTION 'MCPX_SQL_REJECTED'; END IF;
    IF coalesce((st->>'r')::boolean, false) THEN
      EXECUTE 'WITH t AS (' || q || ') SELECT coalesce(jsonb_agg(public.mcpx_rw_row_text(to_jsonb(t))), ''[]''::jsonb) FROM t' INTO rows;
      IF st->>'a' IS NOT NULL AND jsonb_array_length(rows) = 0 THEN
        RAISE EXCEPTION 'MCPX_ABORT:%', st->>'a';
      END IF;
      out := out || jsonb_build_array(jsonb_build_object('rows', rows));
    ELSE
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      out := out || jsonb_build_array(jsonb_build_object('rows', '[]'::jsonb, 'count', n));
    END IF;
  END LOOP;
  RETURN out;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_rw_remote_exec(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_remote_exec(jsonb) TO service_role;
