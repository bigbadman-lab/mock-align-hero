-- 0034 (NOT APPLIED — awaiting review): lets the four AI Playground templates register as products.
-- Move into docs/pending-migrations/ and set tokenLaunch: true + add to TEMPLATES in the same change.

-- 0030: the registrable-template list inside mcpx_cf_register_launch was frozen at the original seven.
-- Templates added to the launch form later (four Intelligence + five AI) were refused at registration with
-- 'template_not_registrable', so their tokens launched on-chain but never became products. Only the list changes;
-- the rest of the function is byte-identical to production. Keep this list equal to TEMPLATES in src/lib/templates.ts
-- (enforced by src/test/registrable-templates.test.ts).
CREATE OR REPLACE FUNCTION public.mcpx_cf_register_launch(_claim uuid, _slot bigint, _quote text, _evidence_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record; d record; cid uuid; b text; slug text;
BEGIN
  SELECT * INTO c FROM mcpx_cf_launch_claims WHERE id = _claim FOR UPDATE;
  IF NOT FOUND THEN RETURN 'claim_not_found'; END IF;
  IF c.status = 'VERIFIED' THEN RETURN 'already_verified:' || c.creation_id; END IF;
  IF c.status = 'REJECTED' THEN RETURN 'claim_rejected'; END IF;
  SELECT * INTO d FROM mcpx_launch_drafts WHERE id = c.draft_id AND creator_wallet = c.creator_wallet FOR UPDATE;
  IF NOT FOUND OR d.revision <> c.draft_revision OR d.status = 'ABANDONED' THEN RETURN 'draft_changed'; END IF;
  IF d.template_id NOT IN ('wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker','canvas',
       'holder-intelligence','token-risk-analyst','smart-money-tracker','onchain-report-builder',
       'gibberish-ai','roast-bot','excuse-machine','conspiracy-potato','argument-machine', 'future-you','web3-startup-roulette','monster-factory','pigeon-ceo') THEN
    RETURN 'template_not_registrable';
  END IF;
  slug := left(regexp_replace(lower(d.symbol), '[^a-z0-9]+', '', 'g'), 20) || '-' || lower(left(c.mint, 8));
  slug := regexp_replace(slug, '^-+', '');
  INSERT INTO mcp_creations (slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint,
    network, verified_tx_signature, verified_slot, verified_at, fee_config_evidence_id)
  VALUES (slug, d.template_id, 1, d.product_name, upper(d.symbol), d.description, c.creator_wallet, c.mint, _quote,
    'solana-mainnet', c.signature, _slot, now(), _evidence_id)
  RETURNING id INTO cid;
  INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, event_version, payload, idempotency_key)
  VALUES ('creation.verified', 'mcp_creation', cid::text, 1,
    jsonb_build_object('creationId', cid, 'templateId', d.template_id, 'childMint', c.mint, 'signature', c.signature, 'slot', _slot),
    'creation.verified:' || c.signature);
  INSERT INTO mcp_product_configs (creation_id, template_id, template_version, config_version, tool_config, access_mode, lifecycle_state, activated_at)
  VALUES (cid, d.template_id, '1.0.0', 1, CASE WHEN d.template_id = 'canvas' THEN '{}'::jsonb ELSE coalesce(d.settings, '{}'::jsonb) END,
    'credential_required', 'active', now());
  IF d.template_id = 'canvas' THEN
    b := mcpx_canvas_bind(cid, d.id, d.revision);
    IF b <> 'bound' THEN RAISE EXCEPTION 'canvas_bind_failed:%', b; END IF; -- whole registration rolls back
  END IF;
  UPDATE mcpx_cf_launch_claims SET status = 'VERIFIED', creation_id = cid, attempts = attempts + 1 WHERE id = c.id;
  RETURN 'registered:' || cid;
END $function$;


-- 0031: mcp_creations.template_id CHECK was frozen at the original seven templates. 0030 widened the list inside
-- mcpx_cf_register_launch, but the INSERT into mcp_creations still failed (23514) for the newer templates, so
-- their tokens launched on-chain but never became products. Only this constraint changes. Keep this list equal
-- to TEMPLATES in src/lib/templates.ts (enforced by src/test/registrable-templates.test.ts).
ALTER TABLE public.mcp_creations DROP CONSTRAINT mcp_creations_template_id_check;
ALTER TABLE public.mcp_creations ADD CONSTRAINT mcp_creations_template_id_check CHECK (template_id = ANY (ARRAY[
  'wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker','canvas',
  'holder-intelligence','token-risk-analyst','smart-money-tracker','onchain-report-builder',
  'gibberish-ai','roast-bot','excuse-machine','conspiracy-potato','argument-machine',
  'future-you','web3-startup-roulette','monster-factory','pigeon-ceo'
]::text[]));
