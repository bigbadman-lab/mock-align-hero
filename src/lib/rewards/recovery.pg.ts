// Phase 05-I.1 recovery persistence (tables in docs/pending-migrations/0011, NOT applied to production).
// Operator-only. Candidates are written in one transaction under a per-window advisory lock; resolution happens only
// inside the SQL function mcpx_rw_hix_resolve_window (match-only, stale-safe). Frozen rows are never touched.
import type { Db } from "./store.pg";
import type { Candidate, FrozenRef } from "./recovery";

const iso = (s: number) => new Date(s * 1000).toISOString();
const js = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function loadRecoveryTarget(db: Db, mint: string, windowStart: number) {
  const f = (await db.query("select cutoff_slot, digest, policy_version, supply_at_cutoff::text s from public.mcpx_rw_hix_frozen_snapshots where mint=$1 and window_start=$2", [mint, iso(windowStart)])).rows[0];
  if (!f) return null;
  const owners = (await db.query("select owner, amount::text a, class from public.mcpx_rw_hix_frozen_owners where mint=$1 and window_start=$2 order by owner", [mint, iso(windowStart)])).rows;
  const holds = (await db.query("select id::int id, reason from public.mcpx_rw_hix_holds where mint=$1 and window_start=$2 and resolved_at is null order by id", [mint, iso(windowStart)])).rows;
  const frozen: FrozenRef = { mint, windowStart, cutoffSlot: Number(f.cutoff_slot), digest: f.digest as string, policyVersion: f.policy_version as string, supply: BigInt(f.s as string),
    owners: owners.map((o) => ({ owner: o.owner as string, amount: BigInt(o.a as string), class: o.class as string })) };
  return { frozen, holds: holds.map((h) => ({ id: Number(h.id), reason: h.reason as string })) };
}

/** Idempotent: the same result against the same open holds returns the existing candidate. */
export async function saveCandidate(db: Db, mint: string, windowStart: number, c: Candidate, a: { correlationId: string; operator: string; provenance: unknown; failAfterInsert?: boolean }) {
  await db.query("begin");
  try {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mcpx_rw_hix_recover:${mint}:${iso(windowStart)}`]);
    const ins = await db.query(`insert into public.mcpx_rw_hix_recovery_candidates (correlation_id, mint, window_start, original_digest, candidate_digest, status, reason, cutoff_slot, hold_ids, comparison, provenance, operator)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint[],$10::jsonb,$11::jsonb,$12) on conflict do nothing returning id`,
      [a.correlationId, mint, iso(windowStart), c.comparison.originalDigest, c.candidateDigest, c.status, c.reason, c.cutoffSlot, `{${c.holdIds.join(",")}}`, js(c.comparison), js(a.provenance), a.operator]);
    if (a.failAfterInsert) throw new Error("SIMULATED_INTERRUPTION");
    let id = ins.rows[0]?.id as string | undefined, created = true;
    if (!id) {
      created = false;
      id = (await db.query(`select id from public.mcpx_rw_hix_recovery_candidates where mint=$1 and window_start=$2 and original_digest=$3 and coalesce(candidate_digest,'')=coalesce($4,'') and status=$5 and coalesce(reason,'')=coalesce($6,'') and hold_ids=$7::bigint[]`,
        [mint, iso(windowStart), c.comparison.originalDigest, c.candidateDigest, c.status, c.reason, `{${c.holdIds.join(",")}}`])).rows[0]?.id as string;
    }
    await db.query("commit");
    return { id, created };
  } catch (e) { await db.query("rollback"); throw e; }
}

export async function resolveWindow(db: Db, candidateId: string, operator: string) {
  return (await db.query("select public.mcpx_rw_hix_resolve_window($1::uuid, $2) r", [candidateId, operator])).rows[0]?.r as string;
}

/** Payout gate: a frozen window with ANY open hold is not usable for planning. */
export async function windowPayableForPlanning(db: Db, mint: string, windowStart: number) {
  const r = (await db.query(`select (select count(*)::int from public.mcpx_rw_hix_holds where mint=$1 and window_start=$2 and resolved_at is null) open_holds,
    (select completeness from public.mcpx_rw_hix_frozen_snapshots where mint=$1 and window_start=$2) completeness`, [mint, iso(windowStart)])).rows[0];
  return !!r && r.completeness === "COMPLETE" && Number(r.open_holds) === 0;
}
