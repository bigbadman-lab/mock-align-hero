REVOKE ALL ON public.mcpx_cf_children FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.mcpx_cf_intents FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.mcpx_cf_intents_guard() FROM anon, authenticated, PUBLIC;