// Durable child-fee keeper state (migration 0021, public.mcpx_cf_*), reached only through the sealed site
// bridge (Db). Completely separate from the native mcpx_rw_* ledger. Identities are unique per child/hour
// (primary key) and per open child (partial unique index); signed bytes are immutable once stored.
import type { Db } from "../../../src/lib/rewards/store.pg";
import type { ChildIntent, ChildRecord, ChildStore } from "./child-fees";

export function childStorePg(db: Db): ChildStore {
  return {
    async reserve(i) {
      const r = await db.query(
        "insert into public.mcpx_cf_intents (idempotency_key, mint, status, action, cost_lamports) values ($1,$2,'RESERVED',$3,$4) on conflict do nothing returning idempotency_key",
        [i.key, i.mint, i.action ?? "DISTRIBUTE", i.costLamports.toString()]);
      return r.rows.length ? "RESERVED" : "DUPLICATE";
    },
    async recordSigned(key, signature, signedBase64, lastValidBlockHeight) {
      const r = await db.query(
        "update public.mcpx_cf_intents set status='SIGNED', signature=$2, signed_tx_base64=$3, last_valid_block_height=$4 where idempotency_key=$1 and status='RESERVED' returning idempotency_key",
        [key, signature, signedBase64, lastValidBlockHeight]);
      if (!r.rows.length) throw new Error("ILLEGAL_TRANSITION");
    },
    async open() {
      const r = await db.query("select idempotency_key, mint, status, signature, signed_tx_base64, last_valid_block_height::text lvbh, cost_lamports::text cost from public.mcpx_cf_intents where status in ('RESERVED','SIGNED') order by created_at");
      return r.rows.map((x): ChildIntent => {
        const i: ChildIntent = { key: x.idempotency_key, mint: x.mint, status: x.status, costLamports: BigInt(x.cost) };
        if (x.signature) i.signature = x.signature;
        if (x.signed_tx_base64) i.signedBase64 = x.signed_tx_base64;
        if (x.lvbh !== null) i.lastValidBlockHeight = Number(x.lvbh);
        return i;
      });
    },
    async finalize(key, status, evidence) {
      const e = evidence as Record<string, unknown> | null;
      const slot = e && typeof e["slot"] === "number" ? e["slot"] : null;
      const dist = e && typeof e["distributed"] === "string" ? e["distributed"] : null;
      const r = await db.query(
        `update public.mcpx_cf_intents set status=$2, evidence=$3::jsonb, finalized_slot=$4, distributed_amount=$5
          where idempotency_key=$1 and (status='SIGNED' or (status='RESERVED' and $2='EXPIRED')) returning idempotency_key`,
        [key, status, JSON.stringify(evidence ?? null), slot, status === "LANDED" ? dist : null]);
      if (!r.rows.length) throw new Error("ILLEGAL_TRANSITION");
    },
    async gasSpentToday() {
      const r = await db.query("select coalesce(sum(cost_lamports),0)::text s from public.mcpx_cf_intents where status <> 'EXPIRED' and created_at >= date_trunc('day', now())");
      return BigInt(r.rows[0]?.s ?? "0");
    },
  };
}

/** Verified MCPX children joined with the registry's creator wallet (the 60% recipient of record). */
export async function loadChildren(db: Db): Promise<(ChildRecord & { registeredCreator: string | null })[]> {
  const r = await db.query(`select c.mint, c.creator_wallet, c.ops_recipient, c.platform_recipient, c.quote_mint, c.quote_token_program, c.sharing_config, m.creator_wallet reg
    from public.mcpx_cf_children c left join public.mcp_creations m on m.child_mint = c.mint order by c.created_at limit 500`);
  return r.rows.map((x) => ({ mint: x.mint, creator: x.creator_wallet, ops: x.ops_recipient, platform: x.platform_recipient, quoteMint: x.quote_mint,
    quoteTokenProgram: x.quote_token_program, sharingConfig: x.sharing_config, registeredCreator: x.reg ?? null }));
}

/** Registry products not yet onboarded to the keeper (quote must be the canonical $MCP mint). */
export async function pendingRegistry(db: Db, quoteMint: string) {
  const r = await db.query(`select m.child_mint, m.creator_wallet, m.verified_tx_signature, m.verified_slot::text slot from public.mcp_creations m
    where m.quote_mint = $1 and m.network = 'solana-mainnet' and not exists (select 1 from public.mcpx_cf_children c where c.mint = m.child_mint) limit 50`, [quoteMint]);
  return r.rows as { child_mint: string; creator_wallet: string; verified_tx_signature: string; slot: string }[];
}

export async function insertChild(db: Db, c: ChildRecord, slot: string, signature: string) {
  await db.query(`insert into public.mcpx_cf_children (mint, creator_wallet, ops_recipient, platform_recipient, quote_mint, quote_token_program, sharing_config, verified_slot, creation_signature)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (mint) do nothing`, [c.mint, c.creator, c.ops, c.platform, c.quoteMint, c.quoteTokenProgram, c.sharingConfig, slot, signature]);
}
