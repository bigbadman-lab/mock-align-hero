-- CANVAS-01 (proposed, NOT applied to production). Additive only.
-- 1) Launch drafts gain an optional Canvas configuration, present iff template_id = 'canvas'.
-- 2) Every saved Canvas configuration is recorded immutably per draft revision (version history).
-- Both stay service-role only (RLS on, no policies), like every other launch table.

ALTER TABLE public.mcpx_launch_drafts ADD COLUMN IF NOT EXISTS canvas_config jsonb;

ALTER TABLE public.mcpx_launch_drafts ADD CONSTRAINT mcpx_launch_drafts_canvas_shape CHECK (
  ((template_id = 'canvas') = (canvas_config IS NOT NULL))
  AND (canvas_config IS NULL OR (
    jsonb_typeof(canvas_config) = 'object'
    AND jsonb_typeof(canvas_config->'catalogVersion') = 'number'
    AND jsonb_typeof(canvas_config->'steps') = 'array'
    AND jsonb_array_length(canvas_config->'steps') BETWEEN 2 AND 4
    AND octet_length(canvas_config::text) <= 4096
  ))
);

CREATE TABLE public.mcpx_canvas_revisions (
  draft_id uuid NOT NULL REFERENCES public.mcpx_launch_drafts(id),
  draft_revision integer NOT NULL CHECK (draft_revision >= 1),
  creator_wallet text NOT NULL,
  catalog_version integer NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, draft_revision)
);
GRANT ALL ON public.mcpx_canvas_revisions TO service_role;
REVOKE ALL ON public.mcpx_canvas_revisions FROM anon, authenticated;
ALTER TABLE public.mcpx_canvas_revisions ENABLE ROW LEVEL SECURITY;

-- History rows are written only by this trigger and can never change.
CREATE OR REPLACE FUNCTION public.mcpx_canvas_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'canvas revisions are immutable'; END $$;
CREATE TRIGGER mcpx_canvas_revisions_no_change BEFORE UPDATE OR DELETE ON public.mcpx_canvas_revisions
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_canvas_revisions_immutable();

CREATE OR REPLACE FUNCTION public.mcpx_canvas_record_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.canvas_config IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.revision <> OLD.revision) THEN
    INSERT INTO public.mcpx_canvas_revisions (draft_id, draft_revision, creator_wallet, catalog_version, config)
    VALUES (NEW.id, NEW.revision, NEW.creator_wallet, (NEW.canvas_config->>'catalogVersion')::int, NEW.canvas_config)
    ON CONFLICT (draft_id, draft_revision) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mcpx_canvas_record_revision() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER mcpx_canvas_record_revision AFTER INSERT OR UPDATE ON public.mcpx_launch_drafts
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_canvas_record_revision();
