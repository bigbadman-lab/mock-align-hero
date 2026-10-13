// Durable signing intents (migration 0016) through the existing query interface — works with the sealed site bridge
// (remoteDb) so the Render worker never holds database credentials. Signed ≠ paid: only finalize() with finalized
// chain evidence can move an intent to LANDED / FAILED_ON_CHAIN / EXPIRED_NOT_LANDED.
import type { IntentStore } from "./signer";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export function intentStore(db: Q, workerId: string): IntentStore & {
  open(): Promise<{ idempotencyKey: string; state: string; signature: string | null; lastValidBlockHeight: number }[]>;
  finalize(key: string, outcome: "LANDED" | "FAILED_ON_CHAIN" | "EXPIRED_NOT_LANDED", finalizedSlot: number, evidence: Record<string, unknown>): Promise<boolean>;
  abandonUnsigned(key: string): Promise<boolean>;
} {
  return {
    async reserve(i) {
      const r = await db.query(
        `insert into public.mcpx_rw_intents (idempotency_key, cycle_id, kind, message_sha256, lamports, last_valid_block_height, reserved_by)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (idempotency_key) do nothing returning idempotency_key`,
        [i.idempotencyKey, i.cycleId, i.kind, i.messageSha256, i.lamports.toString(), i.lastValidBlockHeight, workerId]);
      return r.rows.length === 1 ? "NEW" : "DUPLICATE";
    },
    async cycleSpent(cycleId) {
      // Everything not provably un-spent counts against the cap (reserved, signed, landed, unknown).
      const r = await db.query(`select coalesce(sum(lamports),0)::text s from public.mcpx_rw_intents
        where cycle_id=$1 and state not in ('EXPIRED_NOT_LANDED','ABANDONED_UNSIGNED','FAILED_ON_CHAIN')`, [cycleId]);
      return BigInt(String(r.rows[0]?.s ?? "0"));
    },
    async recordSigned(key, signature) {
      const r = await db.query(`update public.mcpx_rw_intents set state='SIGNED', signature=$2
        where idempotency_key=$1 and state='RESERVED' and signature is null returning idempotency_key`, [key, signature]);
      if (r.rows.length !== 1) throw new Error("intent_not_reserved");
    },
    async open() {
      const r = await db.query(`select idempotency_key, state, signature, last_valid_block_height::text h from public.mcpx_rw_intents
        where state in ('RESERVED','SIGNED') order by created_at`);
      return r.rows.map((x) => ({ idempotencyKey: String(x.idempotency_key), state: String(x.state), signature: (x.signature as string) ?? null, lastValidBlockHeight: Number(x.h) }));
    },
    async finalize(key, outcome, finalizedSlot, evidence) {
      const r = await db.query(`update public.mcpx_rw_intents set state=$2, finalized_slot=$3, evidence=$4::jsonb
        where idempotency_key=$1 and state='SIGNED' returning idempotency_key`, [key, outcome, finalizedSlot, JSON.stringify(evidence)]);
      return r.rows.length === 1;
    },
    async abandonUnsigned(key) {
      const r = await db.query(`update public.mcpx_rw_intents set state='ABANDONED_UNSIGNED'
        where idempotency_key=$1 and state='RESERVED' and signature is null returning idempotency_key`, [key]);
      return r.rows.length === 1;
    },
  };
}
