ALTER TABLE public.mcpx_launch_drafts ADD COLUMN tool_description text NOT NULL DEFAULT '';
ALTER TABLE public.mcpx_launch_drafts ADD CONSTRAINT mcpx_launch_drafts_tool_description_len CHECK (char_length(tool_description) <= 280);
COMMENT ON COLUMN public.mcpx_launch_drafts.tool_description IS 'Optional short MCP tool description (≤280 chars). Not part of token metadata.';