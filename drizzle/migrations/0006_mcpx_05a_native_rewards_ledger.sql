-- Phase 05-A: native $MCP rewards accounting foundation. Service-role only (RLS on, no policies). No execution paths.
CREATE TABLE public.mcpx_rw_fee_events (
  event_key text PRIMARY KEY,
  signature text NOT NULL, ix_index integer NOT NULL CHECK (ix_index >= 0), event_index integer NOT NULL CHECK (event_index >= 0),
  source text NOT NULL CHECK (source IN ('PUMP_CURVE_COLLECT_V2','PUMP_AMM_COLLECT_COIN_CREATOR','PUMP_FEES_DISTRIBUTE_V2')),
  program_id text NOT NULL, mint text NOT NULL, recipient text NOT NULL, asset text NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount >= 0 AND amount <= 18446744073709551615),
  slot bigint NOT NULL, block_time timestamptz NOT NULL, commitment text NOT NULL CHECK (commitment = 'finalized'),
  status text NOT NULL CHECK (status IN ('CREDITED','QUARANTINED')), quarantine_reason text,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signature, ix_index, event_index),
  CHECK (event_key = signature || ':' || ix_index || ':' || event_index),
  CHECK ((status = 'QUARANTINED') = (quarantine_reason IS NOT NULL))
);
CREATE TABLE public.mcpx_rw_allocations (
  seq bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE REFERENCES public.mcpx_rw_fee_events(event_key),
  epoch_start timestamptz NOT NULL,
  receipt_amount numeric(20,0) NOT NULL CHECK (receipt_amount > 0),
  carried_in numeric(20,0) NOT NULL CHECK (carried_in >= 0 AND carried_in < 10000),
  holder_sol numeric(20,0) NOT NULL CHECK (holder_sol >= 0),
  buyback numeric(20,0) NOT NULL CHECK (buyback >= 0),
  operations numeric(20,0) NOT NULL CHECK (operations >= 0),
  residual_out numeric(20,0) NOT NULL CHECK (residual_out >= 0 AND residual_out < 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (holder_sol + buyback + operations + residual_out = receipt_amount + carried_in),
  CHECK (holder_sol = floor((receipt_amount + carried_in) * 3000 / 10000)),
  CHECK (buyback = floor((receipt_amount + carried_in) * 3000 / 10000)),
  CHECK (operations = floor((receipt_amount + carried_in) * 4000 / 10000))
);
CREATE TABLE public.mcpx_rw_cursors (
  source text PRIMARY KEY, last_signature text, last_slot bigint, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.mcpx_rw_epochs (
  epoch_start timestamptz PRIMARY KEY CHECK (extract(epoch FROM epoch_start)::bigint % 300 = 0),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','FUNDED','SNAPSHOT_READY','EXECUTION_PENDING','SETTLED','HELD','FAILED_RETRYABLE','CARRIED_FORWARD')),
  holder_sol_total numeric(20,0) NOT NULL DEFAULT 0, buyback_total numeric(20,0) NOT NULL DEFAULT 0,
  snapshot_id uuid, lease_owner text, lease_until timestamptz, settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'SETTLED') = (settled_at IS NOT NULL))
);
CREATE TABLE public.mcpx_rw_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint text NOT NULL, slot bigint NOT NULL, source text NOT NULL, policy_version text NOT NULL, policy_approved boolean NOT NULL DEFAULT false,
  holder_count integer NOT NULL CHECK (holder_count >= 0), eligible_total numeric(30,0) NOT NULL, excluded_total numeric(30,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.mcpx_rw_snapshot_holders (
  snapshot_id uuid NOT NULL REFERENCES public.mcpx_rw_snapshots(id), owner text NOT NULL,
  amount numeric(30,0) NOT NULL CHECK (amount > 0), PRIMARY KEY (snapshot_id, owner)
);
CREATE TABLE public.mcpx_rw_entitlements (
  epoch_start timestamptz NOT NULL REFERENCES public.mcpx_rw_epochs(epoch_start),
  branch text NOT NULL CHECK (branch IN ('SOL','MCP')), owner text NOT NULL,
  amount numeric(30,0) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (epoch_start, branch, owner)
);
CREATE TABLE public.mcpx_rw_swap_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_start timestamptz NOT NULL UNIQUE REFERENCES public.mcpx_rw_epochs(epoch_start),
  budget_lamports numeric(20,0) NOT NULL CHECK (budget_lamports >= 0), max_slippage_bps integer NOT NULL CHECK (max_slippage_bps BETWEEN 1 AND 1000),
  max_price_impact_bps integer NOT NULL CHECK (max_price_impact_bps BETWEEN 1 AND 1000), min_out_base_units numeric(30,0),
  state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','HELD','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.mcpx_rw_payout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_start timestamptz NOT NULL REFERENCES public.mcpx_rw_epochs(epoch_start),
  branch text NOT NULL CHECK (branch IN ('SOL','MCP')), total numeric(30,0) NOT NULL CHECK (total >= 0),
  state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','HELD','CANCELLED')),
  authorized_by text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (epoch_start, branch)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mcpx_rw_fee_events','mcpx_rw_allocations','mcpx_rw_cursors','mcpx_rw_epochs','mcpx_rw_snapshots','mcpx_rw_snapshot_holders','mcpx_rw_entitlements','mcpx_rw_swap_intents','mcpx_rw_payout_intents'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.mcpx_rw_allocations_seq_seq TO service_role;

-- Append-only: events, allocations, snapshots, holders and entitlements can never change or be deleted.
CREATE OR REPLACE FUNCTION public.mcpx_rw_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN RAISE EXCEPTION 'append_only:%', TG_TABLE_NAME; END $$;
CREATE TRIGGER mcpx_rw_fee_events_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_fee_events FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_allocations_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_allocations FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_snapshots_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_snapshots FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_snapshot_holders_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_snapshot_holders FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();
CREATE TRIGGER mcpx_rw_entitlements_immutable BEFORE UPDATE OR DELETE ON public.mcpx_rw_entitlements FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_immutable();

-- Allocation carry must chain: each allocation's carried_in equals the previous allocation's residual_out.
CREATE OR REPLACE FUNCTION public.mcpx_rw_alloc_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE prev numeric; ev record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mcpx_rw_allocations'));
  SELECT residual_out INTO prev FROM mcpx_rw_allocations ORDER BY seq DESC LIMIT 1;
  IF COALESCE(prev, 0) <> NEW.carried_in THEN RAISE EXCEPTION 'carry_chain_broken'; END IF;
  SELECT status, amount INTO ev FROM mcpx_rw_fee_events WHERE event_key = NEW.event_key;
  IF ev.status IS DISTINCT FROM 'CREDITED' OR ev.amount <> NEW.receipt_amount THEN RAISE EXCEPTION 'allocation_requires_credited_event'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mcpx_rw_alloc_guard BEFORE INSERT ON public.mcpx_rw_allocations FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_alloc_guard();

-- Epoch identity is immutable, settlement is final, and transitions follow the state machine.
CREATE OR REPLACE FUNCTION public.mcpx_rw_epoch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'epoch_delete_forbidden'; END IF;
  IF NEW.epoch_start <> OLD.epoch_start THEN RAISE EXCEPTION 'epoch_identity_immutable'; END IF;
  IF OLD.state IN ('SETTLED','CARRIED_FORWARD') THEN RAISE EXCEPTION 'epoch_final'; END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state='OPEN' AND NEW.state IN ('FUNDED','CARRIED_FORWARD','HELD')) OR
    (OLD.state='FUNDED' AND NEW.state IN ('SNAPSHOT_READY','HELD','FAILED_RETRYABLE')) OR
    (OLD.state='SNAPSHOT_READY' AND NEW.state IN ('EXECUTION_PENDING','HELD','FAILED_RETRYABLE')) OR
    (OLD.state='EXECUTION_PENDING' AND NEW.state IN ('SETTLED','HELD','FAILED_RETRYABLE')) OR
    (OLD.state IN ('FAILED_RETRYABLE','HELD') AND NEW.state IN ('FUNDED','SNAPSHOT_READY','HELD','FAILED_RETRYABLE'))
  ) THEN RAISE EXCEPTION 'illegal_epoch_transition:%->%', OLD.state, NEW.state; END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER mcpx_rw_epoch_guard BEFORE UPDATE OR DELETE ON public.mcpx_rw_epochs FOR EACH ROW EXECUTE FUNCTION public.mcpx_rw_epoch_guard();

-- Read-only conservation check for operators.
CREATE OR REPLACE FUNCTION public.mcpx_rw_conservation() RETURNS TABLE(receipts numeric, allocated numeric, residual numeric, conserved boolean, credited_events bigint, quarantined_events bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT sum(amount) FROM mcpx_rw_fee_events WHERE status='CREDITED'),0),
         COALESCE((SELECT sum(holder_sol+buyback+operations) FROM mcpx_rw_allocations),0),
         COALESCE((SELECT residual_out FROM mcpx_rw_allocations ORDER BY seq DESC LIMIT 1),0),
         COALESCE((SELECT sum(holder_sol+buyback+operations) FROM mcpx_rw_allocations),0) + COALESCE((SELECT residual_out FROM mcpx_rw_allocations ORDER BY seq DESC LIMIT 1),0)
           = COALESCE((SELECT sum(amount) FROM mcpx_rw_fee_events WHERE status='CREDITED'),0),
         (SELECT count(*) FROM mcpx_rw_fee_events WHERE status='CREDITED'),
         (SELECT count(*) FROM mcpx_rw_fee_events WHERE status='QUARANTINED')
$$;
REVOKE ALL ON FUNCTION public.mcpx_rw_conservation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcpx_rw_conservation() TO service_role;
