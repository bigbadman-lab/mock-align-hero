-- MCPX Phase 03-B: one product configuration per verified creation. Server-only; starts empty.
-- ROLLBACK: DROP TABLE public.mcp_product_configs; ALTER TABLE public.mcp_creations DROP CONSTRAINT mcp_creations_id_template_key;
ALTER TABLE public.mcp_creations ADD CONSTRAINT mcp_creations_id_template_key UNIQUE (id, template_id);

CREATE TABLE public.mcp_product_configs (
  creation_id uuid PRIMARY KEY,
  template_id text NOT NULL,
  template_version text NOT NULL CHECK (template_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  tool_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tool_config) = 'object' AND pg_column_size(tool_config) <= 2048),
  access_mode text NOT NULL DEFAULT 'private' CHECK (access_mode IN ('private','credential_required')),
  lifecycle_state text NOT NULL DEFAULT 'inactive' CHECK (lifecycle_state IN ('inactive','active','suspended')),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Template must equal the verified creation's template (real FK, not client-provided).
  FOREIGN KEY (creation_id, template_id) REFERENCES public.mcp_creations (id, template_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (lifecycle_state <> 'active' OR activated_at IS NOT NULL)
);

REVOKE ALL ON public.mcp_product_configs FROM anon, authenticated;
GRANT ALL ON public.mcp_product_configs TO service_role;
ALTER TABLE public.mcp_product_configs ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: resolved only by the server.

CREATE OR REPLACE FUNCTION public.mcpx_product_config_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.creation_id <> OLD.creation_id OR NEW.template_id <> OLD.template_id THEN
    RAISE EXCEPTION 'creation_id and template_id are immutable';
  END IF;
  IF OLD.activated_at IS NOT NULL AND NEW.template_version <> OLD.template_version THEN
    RAISE EXCEPTION 'template_version is pinned once activated';
  END IF;
  IF NEW.tool_config IS DISTINCT FROM OLD.tool_config AND NEW.config_version <= OLD.config_version THEN
    RAISE EXCEPTION 'config_version must increase when tool_config changes';
  END IF;
  NEW.created_at = OLD.created_at;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER mcp_product_configs_guard BEFORE UPDATE ON public.mcp_product_configs
FOR EACH ROW EXECUTE FUNCTION public.mcpx_product_config_guard();