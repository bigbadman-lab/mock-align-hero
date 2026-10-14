-- CANVAS-01 (proposed, NOT applied to production). Additive only; no existing rows change.
-- 1) The verified registry accepts 'canvas' (Template 11). The CHECK is widened, never narrowed:
--    every existing template id stays valid.
-- 2) A Canvas product's pipeline is bound ONLY to a verified registry row (mcp_creations exists only after
--    on-chain verification) and only from an immutable saved draft revision of the same creator wallet.
--    Binding never touches draft status: a prepared or signed transaction never marks anything launched.
-- 3) Later dashboard edits append immutable versions (optimistic: expected current version).
-- All service-role only (RLS on, no policies).

ALTER TABLE public.mcp_creations DROP CONSTRAINT mcp_creations_template_id_check;
ALTER TABLE public.mcp_creations ADD CONSTRAINT mcp_creations_template_id_check CHECK (template_id IN
  ('wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker','canvas'));

CREATE TABLE public.mcpx_canvas_product_versions (
  creation_id uuid NOT NULL REFERENCES public.mcp_creations(id),
  version integer NOT NULL CHECK (version >= 1),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND jsonb_typeof(config->'steps') = 'array'
    AND jsonb_array_length(config->'steps') BETWEEN 2 AND 4 AND octet_length(config::text) <= 4096),
  catalog_version integer NOT NULL,
  source_draft_id uuid REFERENCES public.mcpx_launch_drafts(id),
  source_draft_revision integer,
  actor_wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creation_id, version),
  CHECK ((version = 1) = (source_draft_id IS NOT NULL))
);
GRANT ALL ON public.mcpx_canvas_product_versions TO service_role;
REVOKE ALL ON public.mcpx_canvas_product_versions FROM anon, authenticated;
ALTER TABLE public.mcpx_canvas_product_versions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER mcpx_canvas_product_versions_no_change BEFORE UPDATE OR DELETE ON public.mcpx_canvas_product_versions
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_canvas_revisions_immutable();

-- Bind version 1 from a saved draft revision. Idempotent for the same source; refuses anything else.
CREATE OR REPLACE FUNCTION public.mcpx_canvas_bind(_creation uuid, _draft uuid, _rev integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record; r record; v record;
BEGIN
  SELECT id, template_id, creator_wallet, verified_tx_signature, child_mint INTO c FROM mcp_creations WHERE id = _creation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_verified'; END IF;
  IF c.template_id <> 'canvas' THEN RETURN 'not_canvas'; END IF;
  SELECT * INTO r FROM mcpx_canvas_revisions WHERE draft_id = _draft AND draft_revision = _rev;
  IF NOT FOUND THEN RETURN 'revision_not_found'; END IF;
  IF r.creator_wallet <> c.creator_wallet THEN RETURN 'creator_mismatch'; END IF;
  SELECT * INTO v FROM mcpx_canvas_product_versions WHERE creation_id = _creation AND version = 1;
  IF FOUND THEN
    RETURN CASE WHEN v.source_draft_id = _draft AND v.source_draft_revision = _rev THEN 'already_bound' ELSE 'bound_to_other' END;
  END IF;
  INSERT INTO mcpx_canvas_product_versions (creation_id, version, config, catalog_version, source_draft_id, source_draft_revision, actor_wallet)
  VALUES (_creation, 1, r.config, r.catalog_version, _draft, _rev, c.creator_wallet);
  RETURN 'bound';
END $$;

-- Append a new version; caller must be the verified creator and name the version it edits.
CREATE OR REPLACE FUNCTION public.mcpx_canvas_put_version(_creation uuid, _wallet text, _config jsonb, _catalog integer, _expected integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record; cur integer;
BEGIN
  SELECT id, template_id, creator_wallet INTO c FROM mcp_creations WHERE id = _creation FOR UPDATE;
  IF NOT FOUND OR c.creator_wallet <> _wallet THEN RETURN 'not_found'; END IF;
  IF c.template_id <> 'canvas' THEN RETURN 'not_canvas'; END IF;
  SELECT max(version) INTO cur FROM mcpx_canvas_product_versions WHERE creation_id = _creation;
  IF cur IS NULL THEN RETURN 'not_bound'; END IF;
  IF cur <> _expected THEN RETURN 'stale_version'; END IF;
  INSERT INTO mcpx_canvas_product_versions (creation_id, version, config, catalog_version, actor_wallet)
  VALUES (_creation, cur + 1, _config, _catalog, _wallet);
  RETURN 'ok:' || (cur + 1);
END $$;
REVOKE ALL ON FUNCTION public.mcpx_canvas_bind(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_canvas_put_version(uuid, text, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_canvas_bind(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_canvas_put_version(uuid, text, jsonb, integer, integer) TO service_role;
