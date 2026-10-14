-- CANVAS-01 final (proposed, NOT applied to production). Additive only; no existing rows change.
-- Post-launch verifier storage. A creator submits a claim (draft revision + mint + signature) from the site;
-- Rewards Worker #3 independently verifies the finalized transaction and the locked 60/25/15 sharing config,
-- then calls mcpx_cf_register_launch through the HMAC bridge. Registration writes the verified registry row,
-- its outbox event, its product config and (Canvas only) binds the exact saved Canvas revision — all in one
-- transaction. A claim alone never creates a product, and nothing here changes a draft's status.

CREATE TABLE public.mcpx_cf_launch_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES public.mcpx_launch_drafts(id),
  draft_revision integer NOT NULL CHECK (draft_revision >= 1),
  creator_wallet text NOT NULL CHECK (creator_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  mint text NOT NULL UNIQUE CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signature text NOT NULL UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z0-9_]{1,64}$'),
  attempts integer NOT NULL DEFAULT 0,
  creation_id uuid REFERENCES public.mcp_creations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'VERIFIED') = (creation_id IS NOT NULL))
);
-- One live claim per draft: a draft can't be registered twice or for two mints.
CREATE UNIQUE INDEX mcpx_cf_launch_claims_one_live ON public.mcpx_cf_launch_claims (draft_id) WHERE status <> 'REJECTED';
GRANT ALL ON public.mcpx_cf_launch_claims TO service_role;
REVOKE ALL ON public.mcpx_cf_launch_claims FROM anon, authenticated;
ALTER TABLE public.mcpx_cf_launch_claims ENABLE ROW LEVEL SECURITY;

-- Terminal claims never change again; identity columns never change at all.
CREATE OR REPLACE FUNCTION public.mcpx_cf_launch_claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'launch claims are permanent'; END IF;
  IF OLD.status <> 'PENDING' THEN RAISE EXCEPTION 'launch claim is final'; END IF;
  IF NEW.draft_id <> OLD.draft_id OR NEW.draft_revision <> OLD.draft_revision OR NEW.creator_wallet <> OLD.creator_wallet
     OR NEW.mint <> OLD.mint OR NEW.signature <> OLD.signature THEN RAISE EXCEPTION 'launch claim identity is immutable'; END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER mcpx_cf_launch_claims_guard BEFORE UPDATE OR DELETE ON public.mcpx_cf_launch_claims
  FOR EACH ROW EXECUTE FUNCTION public.mcpx_cf_launch_claims_guard();

-- Called only by the worker AFTER independent finalized on-chain verification. Returns:
-- 'registered:<creation_id>' | 'already_verified:<creation_id>' | 'claim_not_found' | 'claim_rejected'
-- | 'draft_changed' | 'template_not_registrable' | 'canvas_bind_failed:<code>'.
CREATE OR REPLACE FUNCTION public.mcpx_cf_register_launch(_claim uuid, _slot bigint, _quote text, _evidence_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record; d record; cid uuid; b text; slug text;
BEGIN
  SELECT * INTO c FROM mcpx_cf_launch_claims WHERE id = _claim FOR UPDATE;
  IF NOT FOUND THEN RETURN 'claim_not_found'; END IF;
  IF c.status = 'VERIFIED' THEN RETURN 'already_verified:' || c.creation_id; END IF;
  IF c.status = 'REJECTED' THEN RETURN 'claim_rejected'; END IF;
  SELECT * INTO d FROM mcpx_launch_drafts WHERE id = c.draft_id AND creator_wallet = c.creator_wallet FOR UPDATE;
  IF NOT FOUND OR d.revision <> c.draft_revision OR d.status = 'ABANDONED' THEN RETURN 'draft_changed'; END IF;
  IF d.template_id NOT IN ('wallet-inspector','whale-watch','token-scanner','supply-monitor','tx-verifier','account-checker','canvas') THEN
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
END $$;

-- Reject a claim with a fixed reason code (never deletes; never touches registry or drafts).
CREATE OR REPLACE FUNCTION public.mcpx_cf_reject_launch(_claim uuid, _reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE mcpx_cf_launch_claims SET status = 'REJECTED', reason = _reason, attempts = attempts + 1 WHERE id = _claim AND status = 'PENDING';
  RETURN CASE WHEN FOUND THEN 'rejected' ELSE 'not_pending' END;
END $$;

REVOKE ALL ON FUNCTION public.mcpx_cf_register_launch(uuid, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcpx_cf_reject_launch(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_cf_register_launch(uuid, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcpx_cf_reject_launch(uuid, text) TO service_role;
