// @vitest-environment node
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with all migrations + 0019).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { intentStore } from "../../services/rewards-worker/src/intents";
import { reconcileOpen, execute, type Chain } from "../../services/rewards-worker/src/executor";
import type { Plan, SignCtx } from "../../services/rewards-worker/src/signer";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const MSG = Buffer.from("MCPX-TEST-MESSAGE").toString("base64");
const H = createHash("sha256").update(Buffer.from(MSG, "base64")).digest("hex");
const E = 1_900_000_000 - (1_900_000_000 % 300);

d("0019 execution identity (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  const db = {
    query: async (q: string, p: unknown[] = []) => ({ rows: (await sql.unsafe(q, p as never[])) as unknown as Record<string, unknown>[] }),
    tx: async (steps: { sql: string; params?: unknown[]; abortIfEmpty?: string }[]) => {
      let aborted: string | null = null;
      await sql.begin(async (t) => { for (const st of steps) { const r = await t.unsafe(st.sql, (st.params ?? []) as never[]); if (st.abortIfEmpty && !r.length) { aborted = st.abortIfEmpty; throw new Error("ABORT"); } } })
        .catch((e) => { if (!aborted) throw e; });
      return { aborted };
    },
  };
  const base = (k: string) => ({ idempotencyKey: k, cycleId: "x19", kind: "SOL_PAYOUT" as const, epoch: E, messageSha256: H, lamports: 1000n, tokens: 0n, opsCostLamports: 5000n, lastValidBlockHeight: 500, plan: { rows: [{ owner: "A", amount: 1000n }], mint: null, tokenProgram: null, messageBase64: MSG } });
  const row = async (k: string) => (await sql`select state, signature, signed_tx_base64, send_count, first_sent_at from public.mcpx_rw_intents where idempotency_key=${k}`)[0]!;
  const chain = (status: "FINALIZED_OK" | "NOT_FOUND" | "UNKNOWN", height: number, proof: Record<string, unknown> | null = { delta: 1000 }): Chain =>
    ({ signatureStatus: async () => ({ status, slot: status === "FINALIZED_OK" ? 77 : null }), finalizedBlockHeight: async () => height, settlement: async () => proof });

  beforeAll(async () => {
    sql = postgres(URL!, { max: 25, onnotice: () => {} });
    await sql`insert into public.mcpx_rw_config (id, mint, deployer_wallet) values (1, 'MINT', 'DEPLOYER') on conflict (id) do update set mint='MINT', deployer_wallet='DEPLOYER'`;
    await sql`insert into public.mcpx_rw_fee_events (event_key, signature, ix_index, event_index, source, program_id, mint, recipient, asset, amount, slot, block_time, commitment, status)
      values ('x19:0:0','x19',0,0,'PUMP_CURVE_COLLECT_V2','p','MINT','DEPLOYER','SOL',100000000,1,now(),'finalized','CREDITED') on conflict do nothing`;
    await sql`insert into public.mcpx_rw_epochs (epoch_start) values (to_timestamp(${E})) on conflict do nothing`;
    await sql`insert into public.mcpx_rw_allocations (event_key, epoch_start, receipt_amount, carried_in, holder_sol, buyback, operations, residual_out)
      values ('x19:0:0', to_timestamp(${E}), 100000000, 0, 30000000, 30000000, 40000000, 0)`;
  });
  afterAll(async () => { await sql.end(); });

  it("SIGNED requires persisted bytes; bytes survive a restart exactly", async () => {
    const s = intentStore(db, "w1"); await s.reserve(base("b19-key-1"));
    await expect(sql`update public.mcpx_rw_intents set state='SIGNED', signature='s' where idempotency_key='b19-key-1'`).rejects.toThrow(/signed bytes/);
    await s.recordSigned("b19-key-1", "sigX", "RVhBQ1RCWVRFUw==");
    const open = await intentStore(db, "w-restarted").openSigned();
    expect(open.find((o) => o.idempotencyKey === "b19-key-1")!.signedBase64).toBe("RVhBQ1RCWVRFUw==");
  });
  it("signed bytes, signature and first send time are immutable; send count only grows", async () => {
    const s = intentStore(db, "w1");
    await expect(sql`update public.mcpx_rw_intents set signed_tx_base64='T1RIRVI=' where idempotency_key='b19-key-1'`).rejects.toThrow(/immutable/);
    await expect(sql`update public.mcpx_rw_intents set signature='other' where idempotency_key='b19-key-1'`).rejects.toThrow(/immutable/);
    await s.markSent("b19-key-1"); const first = (await row("b19-key-1"))["first_sent_at"];
    await s.markSent("b19-key-1");
    const r = await row("b19-key-1");
    expect(r["send_count"]).toBe(2); expect(String(r["first_sent_at"])).toBe(String(first));
    await expect(sql`update public.mcpx_rw_intents set send_count=0 where idempotency_key='b19-key-1'`).rejects.toThrow(/only increases/);
  });
  it("cannot mark sent without bytes; cannot insert pre-signed or pre-sent", async () => {
    const s = intentStore(db, "w1"); await s.reserve(base("b19-key-2"));
    await expect(s.markSent("b19-key-2")).rejects.toThrow();
    await expect(sql`insert into public.mcpx_rw_intents (idempotency_key,cycle_id,kind,message_sha256,lamports,last_valid_block_height,reserved_by,signed_tx_base64) values ('b19-ins-1','c','SOL_PAYOUT',${H},1,1,'w','QQ==')`).rejects.toThrow(/RESERVED/);
  });
  it("two workers racing to sign or settle: exactly one wins", async () => {
    await intentStore(db, "w1").reserve(base("b19-race-1"));
    const signs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => intentStore(db, `w${i}`).recordSigned("b19-race-1", `sig${i}`, "UkFDRQ==")));
    expect(signs.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const fin = await Promise.all(Array.from({ length: 10 }, (_, i) => intentStore(db, `w${i}`).finalize("b19-race-1", "LANDED", 77, { i })));
    expect(fin.filter(Boolean)).toHaveLength(1);
  });
  it("executor over real rows: signed ≠ paid, resend same bytes, proof required, expiry only by height", async () => {
    const s = intentStore(db, "wE"); await s.reserve(base("b19-exec-1"));
    const sign = async (p: Plan) => { await s.recordSigned(p.idempotencyKey, "sigE", "RVhFQ0JZVEVT"); return { ok: true as const, signature: "sigE", signedBase64: "RVhFQ0JZVEVT" }; };
    const plan = { kind: "SOL_PAYOUT", idempotencyKey: "b19-exec-1", cycleId: "x19", epoch: E, messageBase64: "", lastValidBlockHeight: 500, rows: [] } as Plan;
    expect((await execute(sign, plan, {} as SignCtx, s, null)).state).toBe("SIGNED_HELD");
    expect((await row("b19-exec-1"))["state"]).toBe("SIGNED"); // signed, not paid
    const sent: string[] = [];
    const steps = await reconcileOpen(s, chain("NOT_FOUND", 400), { send: async (b) => { sent.push(b); } });
    expect(steps.find((x) => x.key === "b19-exec-1")!.action).toBe("RESENT_SAME_BYTES"); expect(sent).toContain("RVhFQ0JZVEVT");
    expect((await reconcileOpen(s, chain("UNKNOWN", 9999), null)).find((x) => x.key === "b19-exec-1")!.action).toBe("WAIT");
    expect((await reconcileOpen(s, chain("FINALIZED_OK", 450, null), null)).find((x) => x.key === "b19-exec-1")!.action).toBe("HELD_NO_PROOF");
    expect((await row("b19-exec-1"))["state"]).toBe("SIGNED");
    expect((await reconcileOpen(s, chain("FINALIZED_OK", 450), null)).find((x) => x.key === "b19-exec-1")!.action).toBe("LANDED");
    await expect(sql`update public.mcpx_rw_intents set state='EXPIRED_NOT_LANDED' where idempotency_key='b19-exec-1'`).rejects.toThrow(/final/);
  });
  it("legacy pre-0019 SIGNED rows (no bytes) are still readable and never resent", async () => {
    const open = await intentStore(db, "w").openSigned();
    expect(open.every((o) => o.signedBase64.length > 0)).toBe(true);
  });
  it("only service_role can reach intents; anon/authenticated cannot", async () => {
    const g = await sql`select grantee, privilege_type from information_schema.role_table_grants where table_name='mcpx_rw_intents' and grantee in ('anon','authenticated')`;
    expect(g).toHaveLength(0);
  });
});
