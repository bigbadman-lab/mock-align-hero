-- 0031: mcp_creations.template_id CHECK was frozen at the original seven templates. 0030 widened the list inside
-- mcpx_cf_register_launch, but the INSERT into mcp_creations still failed (23514) for the newer templates, so
-- their tokens launched on-chain but never became products. Only this constraint changes. Keep this list equal
-- to TEMPLATES in src/lib/templates.ts (enforced by src/test/registrable-templates.test.ts).
ALTER TABLE public.mcp_creations DROP CONSTRAINT mcp_creations_template_id_check;
ALTER TABLE public.mcp_creations ADD CONSTRAINT mcp_creations_template_id_check CHECK (template_id = ANY (ARRAY[
  'wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker','canvas',
  'holder-intelligence','token-risk-analyst','smart-money-tracker','onchain-report-builder',
  'gibberish-ai','roast-bot','excuse-machine','conspiracy-potato','argument-machine'
]::text[]));
