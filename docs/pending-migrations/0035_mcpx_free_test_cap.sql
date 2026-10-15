-- 0035: raise the free-test counter's cap so 500 website runs/day per tool are accepted.
CREATE OR REPLACE FUNCTION public.mcpx_free_test_take(_bucket text, _limit integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d date := (now() AT TIME ZONE 'UTC')::date;
  n integer;
BEGIN
  IF _limit < 1 OR _limit > 1000 OR length(_bucket) > 200 THEN RAISE EXCEPTION 'invalid free test arguments'; END IF;
  INSERT INTO public.mcpx_free_test_counts AS c (bucket, day, hits) VALUES (_bucket, d, 1)
  ON CONFLICT (bucket, day) DO UPDATE SET hits = c.hits + 1
  RETURNING hits INTO n;
  DELETE FROM public.mcpx_free_test_counts WHERE day < d - 2;
  RETURN n <= _limit;
END $function$

;
