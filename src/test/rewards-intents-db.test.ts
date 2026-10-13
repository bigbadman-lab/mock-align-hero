// @vitest-environment node
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with migration 0016 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { intentStore } from "../../services/rewards-worker/src/intents";
import { reconcile } from "../../services/rewards-worker/src/signer";

const URL = process.env.MCPX_TEST_PG_URL;
const d = URL ? describe : describe.skip;
const H = "a".repeat(64);
const E1 = 1_800_000_000 - (1_800_000_000 % 300), E2 = E1 + 300, E3 = E1 + 600;

d("0016 durable intents (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  const db = {
    query: async (q: string, p: unknown[] = []) => ({ rows: (await sql.unsafe(q, p as never[])) as unknown as Record<string, unknown>[] }),
    tx: async (steps: { sql: string; params?: unknown[]; abortIfEmpty?: string }[]) => {
      let aborted: string | null = null;
      await sql.begin(async (t) => {
        for (const st of steps) { const r = await t.unsafe(st.sql, (st.params ?? []) as never[]); if (st.abortIfEmpty && !r.length) { aborted = st.abortIfEmpty; throw new Error("ABORT"); } }
      }).catch((e) => { if (!aborted) throw e; });
      return { aborted };
    },
  };
  const base = (k: string, epoch = E1) => ({ idempotencyKey: k, cycleId: "cyc-1", kind: "SOL_PAYOUT" as const, epoch, messageSha256: H, lamports: 1_000_000n, tokens: 0n, opsCostLamports: 5_000n, lastValidBlockHeight: 500 });
  let n = 0;
  const credit = async (epoch: number, mint = "MINT", recipient = "DEPLOYER") => { // 10M lamports → 3M sol / 3M buyback / 4M ops
    const sig = `sig${n++}`;
    await sql`insert into public.mcpx_rw_fee_events (event_key, signature, ix_index, event_index, source, program_id, mint, recipient, asset, amount, slot, block_time, commitment, status)
      values (${sig + ":0:0"}, ${sig}, 0, 0, 'PUMP_CURVE_COLLECT_V2', 'p', ${mint}, ${recipient}, 'SOL', 10000000, 1, now(), 'finalized', 'CREDITED')`;
    await sql`insert into public.mcpx_rw_epochs (epoch_start) values (to_timestamp(${epoch})) on conflict do nothing`;
    await sql`insert into public.mcpx_rw_allocations (event_key, epoch_start, receipt_amount, carried_in, holder_sol, buyback, operations, residual_out)
      values (${sig + ":0:0"}, to_timestamp(${epoch}), 10000000, 0, 3000000, 3000000, 4000000, 0)`;
  };
  beforeAll(async () => {
    sql = postgres(URL!, { max: 25, onnotice: () => {} });
    await sql`insert into public.mcpx_rw_config (id, mint, deployer_wallet) values (1, 'MINT', 'DEPLOYER') on conflict (id) do update set mint='MINT', deployer_wallet='DEPLOYER'`;
    for (let i = 0; i < 4; i++) await credit(E1); // 12M SOL budget for the legacy cases
    await credit(E2);                              // exactly 3M SOL for the contention case
    await credit(E3, "OTHER_MINT"); await credit(E3, "MINT", "ATTACKER"); // foreign records → no budget
  });
  afterAll(async () => { await sql.end(); });

  it("duplicate reservation is refused, also after a 'restart' (new store instance)", async () => {
    expect(await intentStore(db, "w1").reserve(base("dup-key-1"))).toBe("NEW");
    expect(await intentStore(db, "w1-restarted").reserve(base("dup-key-1"))).toBe("DUPLICATE");
  });
  it("concurrent workers: exactly one of 20 parallel reserves wins", async () => {
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => intentStore(db, `w${i}`).reserve(base("race-key-1"))));
    expect(r.filter((x) => x === "NEW")).toHaveLength(1);
  });
  it("concurrent workers, distinct batches: verified 3M budget admits exactly three 1M payouts", async () => {
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => intentStore(db, `w${i}`).reserve(base(`e2-batch-${i}`, E2))));
    expect(r.filter((x) => x === "NEW")).toHaveLength(3);
    expect(r.filter((x) => x === "NO_SOL_BUDGET")).toHaveLength(17);
  });
  it("wrong mint / wrong creator / no fee record → no evidence, nothing reserved", async () => {
    expect(await intentStore(db, "w").reserve(base("e3-forged-1", E3))).toBe("NO_EVIDENCE");
    expect(await intentStore(db, "w").reserve(base("e9-none-1", E3 + 300))).toBe("NO_EVIDENCE");
    expect(await intentStore(db, "w").reserve({ ...base("tok-unbacked-1"), kind: "TOKEN_PAYOUT", lamports: 0n, tokens: 1n })).toBe("NO_TOKEN_BUDGET"); // no finalized fill
    expect(await intentStore(db, "w").reserve({ ...base("ops-huge-1"), opsCostLamports: 10n ** 12n })).toBe("NO_OPS_RESERVE");
  });
  it("signed is never paid: LANDED needs finalized evidence; signing twice or re-signing is refused", async () => {
    const s = intentStore(db, "w1"); await s.reserve(base("sign-key-1"));
    await s.recordSigned("sign-key-1", "sigA");
    await expect(s.recordSigned("sign-key-1", "sigB")).rejects.toThrow();
    const row = (await sql`select state from public.mcpx_rw_intents where idempotency_key='sign-key-1'`)[0]!;
    expect(row.state).toBe("SIGNED");
    await expect(sql`update public.mcpx_rw_intents set state='LANDED' where idempotency_key='sign-key-1'`).rejects.toThrow();
    expect(await s.finalize("sign-key-1", "LANDED", 123, { sig: "sigA" })).toBe(true);
    await expect(sql`update public.mcpx_rw_intents set state='EXPIRED_NOT_LANDED' where idempotency_key='sign-key-1'`).rejects.toThrow(/final/);
  });
  it("cannot skip from RESERVED to LANDED; body and signature are immutable; no deletes", async () => {
    const s = intentStore(db, "w1"); await s.reserve(base("imm-key-1"));
    expect(await s.finalize("imm-key-1", "LANDED", 1, {})).toBe(false);
    await expect(sql`update public.mcpx_rw_intents set lamports=5 where idempotency_key='imm-key-1'`).rejects.toThrow(/immutable/);
    await s.recordSigned("imm-key-1", "sigI");
    await expect(sql`update public.mcpx_rw_intents set signature='other' where idempotency_key='imm-key-1'`).rejects.toThrow(/immutable/);
    await expect(sql`delete from public.mcpx_rw_intents where idempotency_key='imm-key-1'`).rejects.toThrow(/append-only/);
    await expect(sql`insert into public.mcpx_rw_intents (idempotency_key,cycle_id,kind,message_sha256,lamports,last_valid_block_height,reserved_by,state,signature) values ('ins-key-x','c','SOL_PAYOUT',${H},1,1,'w','SIGNED','s')`).rejects.toThrow(/RESERVED/);
  });
  it("mismatched payout data is rejected by the table", async () => {
    await expect(intentStore(db, "w").reserve({ ...base("bad-hash-1"), messageSha256: "nothex" })).rejects.toThrow();
    expect(await intentStore(db, "w").reserve({ ...base("bad-kind-1"), kind: "STEAL" as never })).not.toBe("NEW");
    await expect(intentStore(db, "w").reserve({ ...base("bad-amt-1"), lamports: -1n })).rejects.toThrow();
  });
  it("stale/unknown: open intents survive restart; only provable expiry frees cycle budget", async () => {
    const s = intentStore(db, "w1"); await s.reserve({ ...base("stale-key-1"), cycleId: "cyc-2" }); await s.recordSigned("stale-key-1", "sigS");
    const open = await intentStore(db, "w2").open();
    const o = open.find((x) => x.idempotencyKey === "stale-key-1")!;
    expect(o.state).toBe("SIGNED");
    expect(reconcile(o, { status: "UNKNOWN", finalizedBlockHeight: 900 })).toBe("WAIT");
    expect(await s.cycleSpent("cyc-2")).toBe(1_000_000n);
    expect(reconcile(o, { status: "NOT_FOUND", finalizedBlockHeight: 501 })).toBe("EXPIRED_NOT_LANDED");
    expect(await s.finalize("stale-key-1", "EXPIRED_NOT_LANDED", 600, { checkedHeight: 501 })).toBe(true);
    expect(await s.cycleSpent("cyc-2")).toBe(0n);
    expect(await s.abandonUnsigned("stale-key-1")).toBe(false); // signed intents can never be "abandoned"
  });
});
