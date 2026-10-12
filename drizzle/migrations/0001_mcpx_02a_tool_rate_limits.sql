-- Phase 02-A: shared fixed-window rate-limit counters for tool execution.
-- Server-only (service_role). No browser access. Stores only opaque hashed buckets, never wallet addresses.
-- ROLLBACK: DROP FUNCTION public.mcpx_rate_limit_take(text,integer,integer); DROP TABLE public.mcpx_rate_limits;
CREATE TABLE public.mcpx_rate_limits (
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 128),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  PRIMARY KEY (bucket, window_start)
);
REVOKE ALL ON public.mcpx_rate_limits FROM anon, authenticated;
GRANT ALL ON public.mcpx_rate_limits TO service_role;
ALTER TABLE public.mcpx_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mcpx_rate_limit_take(_bucket text, _window_seconds integer, _limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w timestamptz;
  n integer;
BEGIN
  IF _window_seconds < 1 OR _window_seconds > 3600 OR _limit < 1 THEN
    RAISE EXCEPTION 'invalid rate limit arguments';
  END IF;
  w := to_timestamp(floor(extract(epoch FROM now()) / _window_seconds) * _window_seconds);
  INSERT INTO public.mcpx_rate_limits AS r (bucket, window_start, hits)
  VALUES (_bucket, w, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING hits INTO n;
  DELETE FROM public.mcpx_rate_limits WHERE window_start < now() - interval '2 hours';
  RETURN n <= _limit;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_rate_limit_take(text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rate_limit_take(text,integer,integer) TO service_role;