CREATE TABLE public.mcpx_free_test_counts (
  bucket text NOT NULL,
  day date NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, day)
);
GRANT ALL ON public.mcpx_free_test_counts TO service_role;
ALTER TABLE public.mcpx_free_test_counts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mcpx_free_test_take(_bucket text, _limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d date := (now() AT TIME ZONE 'UTC')::date;
  n integer;
BEGIN
  IF _limit < 1 OR _limit > 100 OR length(_bucket) > 200 THEN RAISE EXCEPTION 'invalid free test arguments'; END IF;
  INSERT INTO public.mcpx_free_test_counts AS c (bucket, day, hits) VALUES (_bucket, d, 1)
  ON CONFLICT (bucket, day) DO UPDATE SET hits = c.hits + 1
  RETURNING hits INTO n;
  DELETE FROM public.mcpx_free_test_counts WHERE day < d - 2;
  RETURN n <= _limit;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_free_test_take(text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_free_test_take(text,integer) TO service_role;