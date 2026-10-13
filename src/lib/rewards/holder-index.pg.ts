// 05-H durable holder-index persistence (mcpx_rw_hix_* tables, service-role only). Worker/server only.
// Each batch is one transaction: applied-tx rows (PK mint+signature) make replay idempotent; balances are only
// written from a state whose applyTx succeeded; the checkpoint can only move forward.
import type { Db } from "./store.pg";
import { initIndex, type IndexState } from "./holder-index";

export async function loadIndex(db: Db, mint: string): Promise<IndexState | null> {
  const c = (await db.query("select anchor_slot, covered_to_slot from public.mcpx_rw_hix_checkpoints where mint=$1", [mint])).rows[0];
  if (!c) return null;
  const s = initIndex(mint, { slot: Number(c.anchor_slot), verified: true, accounts: [] });
  s.coveredTo = Number(c.covered_to_slot);
  for (const r of (await db.query("select token_account, owner, amount::text a from public.mcpx_rw_hix_balances where mint=$1", [mint])).rows)
    s.balances.set(r.token_account, { owner: r.owner, amount: BigInt(r.a) });
  for (const r of (await db.query("select signature from public.mcpx_rw_hix_applied_txs where mint=$1", [mint])).rows) s.applied.add(r.signature);
  for (const r of (await db.query("select from_slot, to_slot, reason from public.mcpx_rw_hix_gaps where mint=$1 and repaired_at is null", [mint])).rows)
    s.gaps.push({ fromSlot: Number(r.from_slot), toSlot: Number(r.to_slot), reason: r.reason });
  return s;
}

/** Persist a successfully applied batch. `txs` = the signatures applied since last save, `touched` = changed accounts. */
export async function saveBatch(db: Db, s: IndexState, source: string, txs: { signature: string; slot: number; blockTime: number | null; failed: boolean }[], touched: Set<string>) {
  await db.query("begin");
  try {
    await db.query(`insert into public.mcpx_rw_hix_checkpoints (mint, anchor_slot, covered_to_slot, source) values ($1,$2,$3,$4)
      on conflict (mint) do update set covered_to_slot = greatest(public.mcpx_rw_hix_checkpoints.covered_to_slot, excluded.covered_to_slot), source = excluded.source, updated_at = now()`,
      [s.mint, s.anchorSlot, s.coveredTo, source]);
    for (const t of txs)
      await db.query("insert into public.mcpx_rw_hix_applied_txs (mint, signature, slot, block_time, failed) values ($1,$2,$3,$4,$5) on conflict do nothing",
        [s.mint, t.signature, t.slot, t.blockTime === null ? null : new Date(t.blockTime * 1000).toISOString(), t.failed]);
    const last = txs[txs.length - 1];
    for (const a of touched) {
      const b = s.balances.get(a);
      if (!b) await db.query("delete from public.mcpx_rw_hix_balances where mint=$1 and token_account=$2", [s.mint, a]);
      else await db.query(`insert into public.mcpx_rw_hix_balances (mint, token_account, owner, amount, last_signature, last_slot) values ($1,$2,$3,$4,$5,$6)
        on conflict (mint, token_account) do update set owner=excluded.owner, amount=excluded.amount, last_signature=excluded.last_signature, last_slot=excluded.last_slot`,
        [s.mint, a, b.owner, b.amount.toString(), last?.signature ?? "anchor", last?.slot ?? s.anchorSlot]);
    }
    for (const g of s.gaps)
      await db.query("insert into public.mcpx_rw_hix_gaps (mint, from_slot, to_slot, reason) values ($1,$2,$3,$4) on conflict do nothing", [s.mint, g.fromSlot, g.toSlot, g.reason]);
    await db.query("commit");
  } catch (e) { await db.query("rollback"); throw e; }
}

export async function markGapRepaired(db: Db, mint: string, g: { fromSlot: number; toSlot: number }, source: string) {
  await db.query("update public.mcpx_rw_hix_gaps set repaired_at = now(), repaired_by_source = $4 where mint=$1 and from_slot=$2 and to_slot=$3 and repaired_at is null", [mint, g.fromSlot, g.toSlot, source]);
}

export async function saveSnapshot(db: Db, mint: string, windowStart: number, slot: number, supply: bigint, holderCount: number, digest: string) {
  const r = await db.query(`insert into public.mcpx_rw_hix_snapshots (mint, window_start, slot, supply, holder_count, digest) values ($1,$2,$3,$4,$5,$6)
    on conflict (mint, window_start) do nothing returning digest`, [mint, new Date(windowStart * 1000).toISOString(), slot, supply.toString(), holderCount, digest]);
  if (r.rows.length) return "INSERTED" as const;
  const ex = (await db.query("select digest from public.mcpx_rw_hix_snapshots where mint=$1 and window_start=$2", [mint, new Date(windowStart * 1000).toISOString()])).rows[0];
  return ex?.digest === digest ? ("DUPLICATE" as const) : ("DIGEST_CONFLICT" as const);
}
