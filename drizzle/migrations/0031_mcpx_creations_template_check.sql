ALTER TABLE public.mcp_creations DROP CONSTRAINT mcp_creations_template_id_check;
ALTER TABLE public.mcp_creations ADD CONSTRAINT mcp_creations_template_id_check CHECK (template_id = ANY (ARRAY[
  'wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker','canvas',
  'holder-intelligence','token-risk-analyst','smart-money-tracker','onchain-report-builder',
  'gibberish-ai','roast-bot','excuse-machine','conspiracy-potato','argument-machine'
]::text[]));