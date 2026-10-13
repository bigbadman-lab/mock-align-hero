-- PENDING (not applied): durable signing intents for the rewards deployer signer.
-- A row is reserved BEFORE signing; the idempotency key is unique so a crash/restart can never sign a second payout.
create table if not exists public.mcpx_rw_intents (
  idempotency_key text primary key,
  cycle_id text not null,
  kind text not null check (kind in ('SOL_PAYOUT','TOKEN_PAYOUT','FEE_COLLECTION','BUYBACK','WSOL_UNWRAP')),
  message_sha256 text not null check (message_sha256 ~ '^[0-9a-f]{64}$'),
  lamports numeric(20,0) not null check (lamports >= 0),
  last_valid_block_height bigint not null,
  signature text,
  state text not null default 'RESERVED' check (state in ('RESERVED','SIGNED','LANDED','FAILED_ON_CHAIN','EXPIRED_NOT_LANDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mcpx_rw_intents_cycle on public.mcpx_rw_intents (cycle_id);
alter table public.mcpx_rw_intents enable row level security;
revoke all on public.mcpx_rw_intents from anon, authenticated;
grant select, insert, update on public.mcpx_rw_intents to service_role;
-- No deletes; signature, once set, can never change.
create or replace function public.mcpx_rw_intents_guard() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'mcpx_rw_intents is append-only'; end if;
  if old.signature is not null and new.signature is distinct from old.signature then raise exception 'signature is immutable'; end if;
  if new.message_sha256 <> old.message_sha256 or new.lamports <> old.lamports then raise exception 'intent body is immutable'; end if;
  new.updated_at := now(); return new;
end $$;
drop trigger if exists mcpx_rw_intents_guard on public.mcpx_rw_intents;
create trigger mcpx_rw_intents_guard before update or delete on public.mcpx_rw_intents for each row execute function public.mcpx_rw_intents_guard();
