// Durable Postgres implementation of the processor Store (05-E). Server/worker only — never imported by browser code.
// The DB is authoritative: lease uses the DB clock, the commit function re-derives totals from stored receipts,
// consumption PKs make double allocation impossible, and the watermark trigger only lets it advance one window.
import { PROCESSOR_VERSION, type Plan, type Receipt, type Store } from "./processor";

/** Minimal driver contract (works with `postgres`/porsager `sql.unsafe` or node-postgres `client.query`). */
export type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  /** Optional atomic batch (remote site store): all steps in ONE transaction, aborted as a whole on abortIfEmpty. */
  tx?(steps: Step[]): Promise<{ aborted: string | null }>;
};
/** One statement of an atomic batch. abortIfEmpty: roll the whole batch back (returning that code) when it returns no rows. */
export type Step = { sql: string; params?: unknown[]; abortIfEmpty?: string };

/** Runs steps atomically on either a direct connection (begin/commit) or a remote batch store. */
export async function runTx(db: Db, steps: Step[]): Promise<{ aborted: string | null }> {
  if (db.tx) return db.tx(steps);
  await db.query("begin");
  try {
    for (const st of steps) {
      const r = await db.query(st.sql, st.params ?? []);
      if (st.abortIfEmpty && !r.rows.length) { await db.query("rollback"); return { aborted: st.abortIfEmpty }; }
    }
    await db.query("commit");
    return { aborted: null };
  } catch (e) { await db.query("rollback"); throw e; }
}

const ts = (s: number) => new Date(s * 1000).toISOString();
const sec = (v: unknown) => Math.floor(new Date(v as string).getTime() / 1000);
export const planToJson = (p: Plan) => JSON.parse(JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const BIG_FIELDS = ["rewardsTotal", "operationsTotal", "solBudget", "buybackBudget", "solDust"] as const;
function planFromJson(j: any): Plan {
  const p = { ...j };
  for (const f of BIG_FIELDS) p[f] = BigInt(j[f]);
  const rows = (xs: any[]) => xs.map((x) => ({ owner: x.owner, lamports: BigInt(x.lamports) }));
  p.solEntitlements = rows(j.solEntitlements); p.solCarriedOut = rows(j.solCarriedOut);
  p.buyback = { ...j.buyback, budgetLamports: BigInt(j.buyback.budgetLamports) };
  p.costs = { estimateLamports: j.costs.estimateLamports === null ? null : BigInt(j.costs.estimateLamports), reserveLamports: j.costs.reserveLamports === null ? null : BigInt(j.costs.reserveLamports), sufficient: j.costs.sufficient };
  return Object.freeze(p) as Plan;
}

export type ReceiptSource = { programId: string; mint: string; sharingConfig: string; rewardsRecipient: string; operationsRecipient: string };

export function pgStore(db: Db, workerId: string, leaseSecondsDefault = 60, src?: ReceiptSource): Store {
  return {
    async acquireLease(owner, now, until) {
      if (owner !== workerId) throw new Error("worker_id_mismatch");
      const ttl = Math.max(5, Math.min(600, Math.round(until - now) || leaseSecondsDefault));
      const r = await db.query("select public.mcpx_rw_acquire_lease($1, $2) as ok", [owner, ttl]);
      return r.rows[0]?.ok === true;
    },
    async releaseLease(owner) { await db.query("select public.mcpx_rw_release_lease($1)", [owner]); },
    async putReceipt(r: Receipt) {
      if (!src) throw new Error("receipt_source_required");
      const [sig, ix, ev] = r.key.split(":");
      const q = await db.query(
        `insert into public.mcpx_rw_sharing_receipts (receipt_key, signature, ix_index, event_index, program_id, mint, sharing_config, slot, block_time, commitment, window_start,
           rewards_recipient, rewards_lamports, operations_recipient, operations_lamports, sol_budget, buyback_budget)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'finalized',$10,$11,$12,$13,$14,$15,$16) on conflict do nothing returning receipt_key`,
        [r.key, sig, Number(ix), Number(ev), src.programId, src.mint, src.sharingConfig, r.slot, ts(r.blockTime), ts(r.window),
          src.rewardsRecipient, r.rewardsLamports.toString(), src.operationsRecipient, r.operationsLamports.toString(), r.solBudget.toString(), r.buybackBudget.toString()]);
      return q.rows.length === 1;
    },
    async receipts() {
      const q = await db.query("select receipt_key, signature, slot, block_time, window_start, rewards_lamports, operations_lamports, sol_budget, buyback_budget from public.mcpx_rw_sharing_receipts");
      return q.rows.map((x) => ({ key: String(x.receipt_key), signature: String(x.signature), slot: Number(x.slot), blockTime: sec(x.block_time), window: sec(x.window_start),
        rewardsLamports: BigInt(String(x.rewards_lamports)), operationsLamports: BigInt(String(x.operations_lamports)), solBudget: BigInt(String(x.sol_budget)), buybackBudget: BigInt(String(x.buyback_budget)) }));
    },
    async watermark() {
      const q = await db.query("select watermark from public.mcpx_rw_proc_state where id = 1");
      const w = q.rows[0]?.watermark; return w ? sec(w) : null;
    },
    async sealedPlan(w) {
      const q = await db.query("select plan from public.mcpx_rw_window_plans where window_start = $1", [ts(w)]);
      const j = q.rows[0]?.plan; return j ? planFromJson(typeof j === "string" ? JSON.parse(j) : j) : null;
    },
    async commitWindow(expected, plan, carry) {
      const carryJson = Object.fromEntries([...carry].map(([o, v]) => [o, v.toString()]));
      const q = await db.query("select public.mcpx_rw_commit_window($1,$2,$3,$4::text::jsonb,$5::text[],$6::text[],$7::text::jsonb,$8) as r",
        [workerId, expected === null ? null : ts(expected), ts(plan.window), JSON.stringify(planToJson(plan)), plan.receiptKeys, plan.adjustmentKeys, JSON.stringify(carryJson), PROCESSOR_VERSION]);
      const r = q.rows[0]?.r;
      if (r === "LEASE_LOST") return "LEASE_LOST";
      return r === "COMMITTED";
    },
    async ownerCarry() {
      const q = await db.query("select owner, lamports from public.mcpx_rw_owner_carry where window_start = (select max(window_start) from public.mcpx_rw_window_plans)");
      return new Map(q.rows.map((x) => [String(x.owner), BigInt(String(x.lamports))]));
    },
    async consumed() {
      const q = await db.query("select receipt_key from public.mcpx_rw_receipt_consumption");
      return new Set(q.rows.map((x) => String(x.receipt_key)));
    },
  };
}
