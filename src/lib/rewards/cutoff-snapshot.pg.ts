// Phase 05-I persistence for cutoffs, frozen snapshots and repair holds (tables in docs/pending-migrations/0010, NOT
// applied to production yet). Worker/server only. All writes for one index pass happen in ONE transaction on ONE
// connection, guarded by a compare-and-swap on the holder-index checkpoint: a slower/older process can never
// overwrite newer balances, and two racing processes produce exactly one committed pass.
import { runTx, type Db, type Step } from "./store.pg";
import type { IndexState } from "./holder-index";
import type { CutoffEvidence, CutoffResult } from "./cutoff";
import type { FrozenSnapshot } from "./cutoff-snapshot";
import type { EligibilityPolicy } from "./eligibility-policy";
import type { SupplyProof } from "./supply-proof";

const iso = (s: number) => new Date(s * 1000).toISOString();
const js = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function savePolicy(db: Db, p: EligibilityPolicy) {
  await db.query(`insert into public.mcpx_rw_eligibility_policies (version, status, effective_from_window, body, approved_by) values ($1,$2,$3,$4::jsonb,$5) on conflict (version) do nothing`,
    [p.version, p.status, iso(p.effectiveFromWindow), js(p), p.approvedBy]);
}
export async function loadPolicies(db: Db): Promise<EligibilityPolicy[]> {
  return (await db.query("select body from public.mcpx_rw_eligibility_policies order by effective_from_window")).rows.map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body));
}

export async function saveCutoff(db: Db, mint: string, windowStart: number, r: CutoffResult) {
  if (r.kind === "HOLD") {
    await db.query(`insert into public.mcpx_rw_hix_window_cutoffs (mint, window_start, window_end, status, selection_method, hold_reason, evidence) values ($1,$2,$3,'ON_HOLD','CUTOFF_RULE_V1',$4,$5::jsonb)
      on conflict (mint, window_start) do update set hold_reason = excluded.hold_reason, evidence = excluded.evidence where public.mcpx_rw_hix_window_cutoffs.status = 'ON_HOLD'`,
      [mint, iso(windowStart), iso(windowStart + 300), r.reason, js({ detail: r.detail ?? null })]);
    return "HELD" as const;
  }
  const e = r.evidence;
  const ex = (await db.query("select status, cutoff_slot from public.mcpx_rw_hix_window_cutoffs where mint=$1 and window_start=$2", [mint, iso(windowStart)])).rows[0];
  if (ex?.status === "SELECTED") return Number(ex.cutoff_slot) === e.cutoffSlot ? ("DUPLICATE" as const) : ("CONFLICT" as const);
  const sql = ex ? `update public.mcpx_rw_hix_window_cutoffs set status='SELECTED', cutoff_slot=$3, cutoff_block_time=$4, next_slot=$5, next_block_time=$6, finalized_head=$7, finalized_head_time=$8, selection_method=$9, hold_reason=null, evidence=$10::jsonb, selected_at=now() where mint=$1 and window_start=$2 and status='ON_HOLD'`
    : `insert into public.mcpx_rw_hix_window_cutoffs (mint, window_start, cutoff_slot, cutoff_block_time, next_slot, next_block_time, finalized_head, finalized_head_time, selection_method, evidence, window_end, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'SELECTED') on conflict do nothing`;
  const p = [mint, iso(windowStart), e.cutoffSlot, iso(e.cutoffBlockTime), e.nextSlot, iso(e.nextBlockTime), e.finalizedHead, iso(e.finalizedHeadTime), e.rule, js(e)];
  await db.query(sql, ex ? p : [...p, iso(windowStart + 300)]);
  const now = (await db.query("select cutoff_slot from public.mcpx_rw_hix_window_cutoffs where mint=$1 and window_start=$2", [mint, iso(windowStart)])).rows[0];
  return Number(now?.cutoff_slot) === e.cutoffSlot ? ("SELECTED" as const) : ("CONFLICT" as const);
}

export async function loadSelectedCutoffs(db: Db, mint: string, afterSlot: number): Promise<CutoffEvidence[]> {
  return (await db.query("select evidence from public.mcpx_rw_hix_window_cutoffs w where mint=$1 and status='SELECTED' and cutoff_slot > $2 and not exists (select 1 from public.mcpx_rw_hix_frozen_snapshots f where f.mint=w.mint and f.window_start=w.window_start) order by window_start", [mint, afterSlot]))
    .rows.map((r) => (typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence));
}

export type PassWrite = {
  state: IndexState; expectedCoveredTo: number; source: string;
  txs: { signature: string; slot: number; blockTime: number | null; failed: boolean }[]; touched: Set<string>;
  frozen: { snap: FrozenSnapshot; supply: SupplyProof }[]; holds: { windowStart: number; reason: string; detail?: unknown }[];
  /** Open gaps this pass fully re-covered with complete, verified history (marked repaired in the same transaction). */
  repairedGaps?: { fromSlot: number; toSlot: number }[];
  /** No gaps remain after repair → resolve HOLDER_HISTORY_GAP holds (they only existed because of those gaps). */
  resolveGapHolds?: boolean;
};

/** One pass = one transaction. Returns STALE if another process already advanced the checkpoint.
 * Built as a flat step list so the same atomic pass runs on a direct connection or through the site's sealed batch. */
export async function commitPass(db: Db, w: PassWrite): Promise<"COMMITTED" | "STALE"> {
  const s = w.state;
  const steps: Step[] = [
    { sql: "insert into public.mcpx_rw_hix_checkpoints (mint, anchor_slot, covered_to_slot, source) values ($1,$2,$2,$3) on conflict do nothing", params: [s.mint, s.anchorSlot, w.source] },
    { sql: "update public.mcpx_rw_hix_checkpoints set covered_to_slot=$3, source=$4, updated_at=now() where mint=$1 and covered_to_slot=$2 returning mint", params: [s.mint, w.expectedCoveredTo, s.coveredTo, w.source], abortIfEmpty: "STALE" },
  ];
  for (const t of w.txs) steps.push({ sql: "insert into public.mcpx_rw_hix_applied_txs (mint, signature, slot, block_time, failed) values ($1,$2,$3,$4,$5) on conflict do nothing",
    params: [s.mint, t.signature, t.slot, t.blockTime === null ? null : iso(t.blockTime), t.failed] });
  const last = w.txs[w.txs.length - 1];
  for (const a of w.touched) {
    const b = s.balances.get(a);
    if (!b) steps.push({ sql: "delete from public.mcpx_rw_hix_balances where mint=$1 and token_account=$2", params: [s.mint, a] });
    else steps.push({ sql: `insert into public.mcpx_rw_hix_balances (mint, token_account, owner, amount, last_signature, last_slot) values ($1,$2,$3,$4,$5,$6)
      on conflict (mint, token_account) do update set owner=excluded.owner, amount=excluded.amount, last_signature=excluded.last_signature, last_slot=excluded.last_slot`, params: [s.mint, a, b.owner, b.amount.toString(), last?.signature ?? "anchor", last?.slot ?? s.anchorSlot] });
  }
  for (const g of s.gaps) {
    steps.push({ sql: "insert into public.mcpx_rw_hix_gaps (mint, from_slot, to_slot, reason) values ($1,$2,$3,$4) on conflict do nothing", params: [s.mint, g.fromSlot, g.toSlot, g.reason] });
    // a gap reaching back before an already-frozen cutoff = late pre-cutoff data: hold, never rewrite
    steps.push({ sql: `insert into public.mcpx_rw_hix_holds (mint, window_start, reason, detail) select mint, window_start, 'LATE_PRE_CUTOFF_DATA', jsonb_build_object('gapFrom',$2::bigint,'gapTo',$3::bigint)
      from public.mcpx_rw_hix_frozen_snapshots where mint=$1 and cutoff_slot >= $2 on conflict do nothing`, params: [s.mint, g.fromSlot, g.toSlot] });
  }
  for (const { snap: f, supply } of w.frozen) {
    const ws = iso(f.windowStart);
    // an already-frozen window with a different digest → DIGEST_CONFLICT hold (checked BEFORE our insert can happen)
    steps.push({ sql: `insert into public.mcpx_rw_hix_holds (mint, window_start, reason, detail) select mint, window_start, 'DIGEST_CONFLICT', jsonb_build_object('existing', digest, 'recomputed', $3::text)
      from public.mcpx_rw_hix_frozen_snapshots where mint=$1 and window_start=$2::timestamptz and digest <> $3::text on conflict do nothing`, params: [f.mint, ws, f.digest] });
    steps.push({ sql: `insert into public.mcpx_rw_hix_frozen_snapshots (mint, window_start, cutoff_slot, checkpoint_slot, policy_version, supply_at_cutoff, indexed_total, supply_proof, eligible_total, excluded_total, ambiguous_total, completeness, digest)
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) on conflict do nothing`,
      params: [f.mint, ws, f.cutoffSlot, f.checkpointSlot, f.policyVersion, f.supplyAtCutoff.toString(), f.indexedTotal.toString(), js(supply), f.eligibleTotal.toString(), f.excludedTotal.toString(), f.ambiguousTotal.toString(), f.completeness, f.digest] });
    // owners only for the snapshot carrying THIS digest (frozen rows are immutable; a duplicate pass is a no-op)
    for (const o of f.owners) steps.push({ sql: `insert into public.mcpx_rw_hix_frozen_owners (mint, window_start, owner, amount, class, reason)
        select $1::text, $2::timestamptz, $3::text, $4::numeric, $5::text, $6::text where exists (select 1 from public.mcpx_rw_hix_frozen_snapshots where mint=$1::text and window_start=$2::timestamptz and digest=$7::text) on conflict do nothing`,
      params: [f.mint, ws, o.owner, o.amount.toString(), o.class, o.reason, f.digest] });
  }
  for (const h of w.holds) steps.push({ sql: "insert into public.mcpx_rw_hix_holds (mint, window_start, reason, detail) values ($1,$2,$3,$4::jsonb) on conflict do nothing", params: [s.mint, iso(h.windowStart), h.reason, js(h.detail ?? {})] });
  for (const g of w.repairedGaps ?? []) steps.push({ sql: "update public.mcpx_rw_hix_gaps set repaired_at = now(), repaired_by_source = $4 where mint=$1 and from_slot=$2 and to_slot=$3 and repaired_at is null",
    params: [s.mint, g.fromSlot, g.toSlot, `replay:${w.source}`] });
  if (w.resolveGapHolds) steps.push({ sql: "update public.mcpx_rw_hix_holds set resolved_at = now(), resolution = 'AUTO_REPAIRED_BY_FULL_REPLAY' where mint=$1 and reason='HOLDER_HISTORY_GAP' and resolved_at is null", params: [s.mint] });
  const r = await runTx(db, steps);
  return r.aborted === "STALE" ? "STALE" : "COMMITTED";
}

export async function openHoldWindows(db: Db, mint: string): Promise<Set<number>> {
  return new Set((await db.query("select extract(epoch from window_start)::bigint w from public.mcpx_rw_hix_holds where mint=$1 and resolved_at is null", [mint])).rows.map((r) => Number(r.w)));
}

export async function loadFrozen(db: Db, mint: string, windowStart: number) {
  const f = (await db.query("select * from public.mcpx_rw_hix_frozen_snapshots where mint=$1 and window_start=$2", [mint, iso(windowStart)])).rows[0];
  if (!f) return null;
  const owners = (await db.query("select owner, amount::text a, class, reason from public.mcpx_rw_hix_frozen_owners where mint=$1 and window_start=$2 order by owner", [mint, iso(windowStart)])).rows;
  return { cutoffSlot: Number(f.cutoff_slot), policyVersion: f.policy_version as string, digest: f.digest as string, completeness: f.completeness as string,
    supply: BigInt(f.supply_at_cutoff), eligibleTotal: BigInt(f.eligible_total), owners: owners.map((o) => ({ owner: o.owner as string, amount: BigInt(o.a), class: o.class as string, reason: o.reason as string | null })) };
}
