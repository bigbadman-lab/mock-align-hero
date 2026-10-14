-- 0026 MCPX tool activity (PENDING — not applied to production; requires separate approval).
-- One row per external MCP product tool call (Canvas = one row per request). No inputs, outputs, keys or wallets.
-- Retention: 90 days. The record function purges a bounded batch of expired rows on every write,
-- mcpx_tool_activity_purge() allows a full sweep, and dashboard reads filter to the same 90 days.
CREATE TABLE public.mcpx_tool_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creation_id uuid NOT NULL REFERENCES public.mcp_creations(id) ON DELETE CASCADE,
  tool_id text NOT NULL CHECK (tool_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'error')),
  execution_ref uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcpx_tool_activity_by_product ON public.mcpx_tool_activity (creation_id, occurred_at DESC, id DESC);
CREATE INDEX mcpx_tool_activity_by_time ON public.mcpx_tool_activity (occurred_at);

REVOKE ALL ON public.mcpx_tool_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mcpx_tool_activity TO service_role;
ALTER TABLE public.mcpx_tool_activity ENABLE ROW LEVEL SECURITY;
-- No policies: browser roles have no access; the server reads with service_role after checking ownership.

-- Idempotent write: a retried record with the same execution_ref never creates a second row.
CREATE OR REPLACE FUNCTION public.mcpx_tool_activity_record(_creation uuid, _tool text, _outcome text, _ref uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  IF _outcome NOT IN ('ok', 'error') THEN RETURN 'bad_outcome'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mcp_creations WHERE id = _creation) THEN RETURN 'unknown_product'; END IF;
  INSERT INTO public.mcpx_tool_activity (creation_id, tool_id, outcome, execution_ref)
  VALUES (_creation, _tool, _outcome, _ref) ON CONFLICT (execution_ref) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.mcpx_tool_activity WHERE id IN (
    SELECT id FROM public.mcpx_tool_activity WHERE occurred_at < now() - interval '90 days' ORDER BY occurred_at LIMIT 100);
  RETURN CASE WHEN n = 1 THEN 'recorded' ELSE 'duplicate' END;
END $$;

CREATE OR REPLACE FUNCTION public.mcpx_tool_activity_purge(_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  DELETE FROM public.mcpx_tool_activity WHERE id IN (
    SELECT id FROM public.mcpx_tool_activity WHERE occurred_at < now() - interval '90 days'
    ORDER BY occurred_at LIMIT greatest(1, least(coalesce(_batch, 1000), 10000)));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.mcpx_tool_activity_record(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_tool_activity_purge(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_tool_activity_record(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_tool_activity_purge(integer) TO service_role;
