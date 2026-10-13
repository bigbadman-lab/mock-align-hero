// Durable signing intents (migration 0016) through the existing query interface — works with the sealed site bridge
// (remoteDb) so the Render worker never holds database credentials. Signed ≠ paid: only finalize() with finalized
// chain evidence can move an intent to LANDED / FAILED_ON_CHAIN / EXPIRED_NOT_LANDED.
import type { IntentStore } from "./signer";
import type { ExecStore, OpenIntent } from "./executor";
import { runTx } from "../../../src/lib/rewards/store.pg";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export function intentStore(db: Q, workerId: string): IntentStore & Omit<ExecStore, "finalize"> & {
  open(): Promise<{ idempotencyKey: string; state: string; signature: string | null; lastValidBlockHeight: number }[]>;
  finalize(key: string, outcome: "LANDED" | "FAILED_ON_CHAIN" | "EXPIRED_NOT_LANDED", finalizedSlot: number, evidence: Record<string, unknown>): Promise<boolean>;
  abandonUnsigned(key: string): Promise<boolean>;
} {
  return {
    async reserve(i) {
      // One sealed transaction: config-row lock (serialises concurrent workers), then insert only if the key is
      // new AND the persisted fee-backed budget covers it. Budget is derived in SQL from finalized records only.
      const ins = `insert into public.mcpx_rw_intents (idempotency_key, cycle_id, kind, message_sha256, lamports, last_valid_block_height, reserved_by, epoch_start, token_amount, ops_cost_lamports)
        select $1,$2,$3,$4,$5::numeric,$6,$7,to_timestamp($8),$9::numeric,$10::numeric
        where not exists (select 1 from public.mcpx_rw_intents where idempotency_key=$1)
          and exists (select 1 from public.mcpx_rw_budget_remaining(to_timestamp($8)) b where b.evidence and b.ops >= $10::numeric and
            case $3 when 'SOL_PAYOUT' then b.sol >= $5::numeric when 'BUYBACK' then b.buyback >= $5::numeric
                    when 'TOKEN_PAYOUT' then $5::numeric = 0 and b.tokens >= $9::numeric else false end)
        returning idempotency_key`;
      const p = [i.idempotencyKey, i.cycleId, i.kind, i.messageSha256, i.lamports.toString(), i.lastValidBlockHeight, workerId, i.epoch, i.tokens.toString(), i.opsCostLamports.toString()];
      const r = await runTx(db as never, [
        // Row lock on the single config row serialises all budget reservations (pg_* calls are refused by the bridge guard).
        { sql: "select id from public.mcpx_rw_config where id = 1 for update", params: [], abortIfEmpty: "NO_CONFIG" },
        { sql: ins, params: p, abortIfEmpty: "REFUSED" },
      ]);
      if (!r.aborted) return "NEW";
      if (r.aborted === "NO_CONFIG") return "NO_EVIDENCE";
      const dup = await db.query("select 1 from public.mcpx_rw_intents where idempotency_key=$1", [i.idempotencyKey]);
      if (dup.rows.length) return "DUPLICATE";
      const b = (await db.query("select sol::text, buyback::text, tokens::text, ops::text, evidence from public.mcpx_rw_budget_remaining(to_timestamp($1))", [i.epoch])).rows[0];
      if (!b || !b["evidence"]) return "NO_EVIDENCE";
      if (BigInt(String(b["ops"])) < i.opsCostLamports) return "NO_OPS_RESERVE";
      return i.kind === "SOL_PAYOUT" ? "NO_SOL_BUDGET" : i.kind === "BUYBACK" ? "NO_BUYBACK_BUDGET" : "NO_TOKEN_BUDGET";
    },
    async cycleSpent(cycleId) {
      // Everything not provably un-spent counts against the cap (reserved, signed, landed, unknown).
      const r = await db.query(`select coalesce(sum(lamports),0)::text s from public.mcpx_rw_intents
        where cycle_id=$1 and state not in ('EXPIRED_NOT_LANDED','ABANDONED_UNSIGNED','FAILED_ON_CHAIN')`, [cycleId]);
      return BigInt(String(r.rows[0]?.["s"] ?? "0"));
    },
    async recordSigned(key, signature, signedBase64) {
      const r = await db.query(`update public.mcpx_rw_intents set state='SIGNED', signature=$2, signed_tx_base64=$3
        where idempotency_key=$1 and state='RESERVED' and signature is null returning idempotency_key`, [key, signature, signedBase64]);
      if (r.rows.length !== 1) throw new Error("intent_not_reserved");
    },
    async open() {
      const r = await db.query(`select idempotency_key, state, signature, last_valid_block_height::text h from public.mcpx_rw_intents
        where state in ('RESERVED','SIGNED') order by created_at`);
      return r.rows.map((x) => ({ idempotencyKey: String(x["idempotency_key"]), state: String(x["state"]), signature: (x["signature"] as string) ?? null, lastValidBlockHeight: Number(x["h"]) }));
    },
    async finalize(key, outcome, finalizedSlot, evidence) {
      const r = await db.query(`update public.mcpx_rw_intents set state=$2, finalized_slot=$3, evidence=$4::jsonb
        where idempotency_key=$1 and state='SIGNED' returning idempotency_key`, [key, outcome, finalizedSlot, JSON.stringify(evidence)]);
      return r.rows.length === 1;
    },
    async markSent(key) {
      const r = await db.query(`update public.mcpx_rw_intents set first_sent_at=coalesce(first_sent_at, now()), send_count=send_count+1
        where idempotency_key=$1 and state='SIGNED' and signed_tx_base64 is not null returning idempotency_key`, [key]);
      if (r.rows.length !== 1) throw new Error("intent_not_signed");
    },
    async openSigned(): Promise<OpenIntent[]> {
      // Rows (recipients) are re-checked from the persisted plan fingerprint by the settlement verifier; the executor
      // needs identity + exact bytes only.
      const r = await db.query(`select idempotency_key, kind, signature, signed_tx_base64, last_valid_block_height::text h
        from public.mcpx_rw_intents where state='SIGNED' and signed_tx_base64 is not null order by created_at`);
      return r.rows.map((x) => ({ idempotencyKey: String(x["idempotency_key"]), kind: String(x["kind"]), signature: String(x["signature"]),
        signedBase64: String(x["signed_tx_base64"]), lastValidBlockHeight: Number(x["h"]), rows: [] }));
    },
    async abandonUnsigned(key) {
      const r = await db.query(`update public.mcpx_rw_intents set state='ABANDONED_UNSIGNED'
        where idempotency_key=$1 and state='RESERVED' and signature is null returning idempotency_key`, [key]);
      return r.rows.length === 1;
    },
  };
}
