# 05-I / 05-I.1 production migration preflight (READ ONLY — nothing applied)

## Files (apply in this order, each in its own transaction)
1. docs/pending-migrations/0010_mcpx_05i_cutoff_snapshots.sql
2. docs/pending-migrations/0011_mcpx_05i1_recovery.sql
Rollback (only before any real data exists): docs/pending-migrations/rollback_0011_0010.sql

## Object inventory
- 0010 tables: public.mcpx_rw_hix_window_cutoffs, public.mcpx_rw_eligibility_policies, public.mcpx_rw_hix_frozen_snapshots, public.mcpx_rw_hix_frozen_owners, public.mcpx_rw_hix_holds (+ sequence mcpx_rw_hix_holds_id_seq).
  - Constraints: primary keys; foreign keys frozen→cutoffs, owners→frozen, frozen→policies; checks for window alignment, a valid SELECTED bracket, indexed total = supply, and the class sums.
  - Function public.mcpx_rw_hix_immutable() with 4 triggers that block UPDATE/DELETE. The one exception: an ON_HOLD cutoff may become SELECTED.
- 0011 tables: public.mcpx_rw_hix_recovery_candidates (indexes: dedupe unique, window), public.mcpx_rw_hix_recovery_decisions (+ sequence). Index mcpx_rw_hix_holds_open.
  - Functions: mcpx_rw_hix_recovery_immutable(), mcpx_rw_hix_holds_guard() (trigger on holds), mcpx_rw_hix_resolve_window(uuid,text) SECURITY DEFINER with search_path=public.
- Grants: RLS enabled with no policies on every table; ALL revoked from anon and authenticated; ALL granted to service_role. EXECUTE on resolve_window granted to service_role only, revoked from PUBLIC.

## Relationship to the existing schema
- Depends on 0009 (mcpx_rw_hix_*) and gen_random_uuid() (built in from PG13).
- Production read-only check (this session): the 5 tables from 0009 exist with 0 rows and anon/authenticated have no SELECT. None of the 0010/0011 names exist, so there are no conflicts.
- Additive only: no existing object is changed. The website does not read these tables.

## Protections and bypass (honest)
- The triggers block UPDATE/DELETE for every role. A table owner or superuser can still disable triggers or set `session_replication_role=replica`. service_role in this backend is not the table owner, but the platform's migration role is. Immutability is therefore enforced by the database against the worker and API, not against the database owner.

## Locks and runtime
- Only CREATE statements, on new or empty objects. The trigger added to mcpx_rw_hix_holds is created in 0010's own transaction. Local apply of both: 73 ms. No backfill needed.
- Growth: per mint and window, 1 cutoff row + 1 frozen row + one row per holder (owners). That is ~288 windows/day × holders; at 1,000 holders, ~288k owner rows/day. Retention or partitioning is needed before scale (OPEN).
- Not idempotent: re-running 0010 fails with "already exists". The migration journal must ensure a single run.

## Local validation (throwaway PG 16.13)
- 0000–0009, then 0010 and 0011: OK.
- Rollback: OK. Re-apply: OK.
- RLS on and privileges checked for all 7 new tables.
- The local database resembles production only through the repo's migrations plus stub auth/roles. Platform-specific extensions and roles are UNVERIFIED.

## Read-only commands for the operator (run with the database query tool, read only)
```sql
select table_name from information_schema.tables where table_schema='public' and table_name ~ '^mcpx_rw_(hix|eligibility)';
select count(*) from public.mcpx_rw_hix_checkpoints;
select has_table_privilege('anon','public.mcpx_rw_hix_balances','select');
```

## Approval checklist before production apply
- [ ] Operator approves 0010 + 0011 by filename and checksum.
- [ ] Owner-bypass limitation accepted.
- [ ] Retention/growth plan accepted.
- [ ] Pre-apply read-only checks re-run (no name conflicts, 0009 tables empty).
- [ ] Applied through the project's migration tool only (never by hand). Post-apply privilege check.
