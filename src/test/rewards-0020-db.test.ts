// @vitest-environment node
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with all migrations + 0020).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { intentStore } from "../../services/rewards-worker/src/intents";
import { captureFills, pendingFills, persistedPlan } from "../../services/rewards-worker/src/pipeline";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const MSG = Buffer.from("MCPX-0020-MESSAGE").toString("base64");
const H = createHash("sha256").update(Buffer.from(MSG, "base64")).digest("hex");
const E = 1_910_000_000 - (1_910_000_000 % 300);

d("0020 immutable payout plans (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  const db = { query: async (q: string, p: unknown[] = []) => ({ rows: (await sql.unsafe(q, p as never[])) as unknown as Record<string, unknown>[] }),
    tx: async (steps: { sql: string; params?: unknown[]; abortIfEmpty?: string }[]) => { let aborted: string | null = null;
      await sql.begin(async (t) => { for (const st of steps) { const r = await t.unsafe(st.sql, (st.params ?? []) as never[]); if (st.abortIfEmpty && !r.length) { aborted = st.abortIfEmpty; throw new Error("ABORT"); } } }).catch((e) => { if (!aborted) throw e; });
      return { aborted }; } };
  const rows = [{ owner: "HolderA", amount: 600n }, { owner: "HolderB", amount: 400n }];
  const base = (k: string, over: Record<string, unknown> = {}) => ({ idempotencyKey: k, cycleId: "c20", kind: "SOL_PAYOUT" as const, epoch: E, messageSha256: H, lamports: 1000n, tokens: 0n,
    opsCostLamports: 5000n, lastValidBlockHeight: 500, plan: { rows, mint: null, tokenProgram: null, messageBase64: MSG }, ...over });
  const raw = (k: string, kind: string, planRows: unknown, msg: string | null, lamports = 1000, tokens = 0, mint: string | null = null, prog: string | null = null) =>
    sql`insert into public.mcpx_rw_intents (idempotency_key,cycle_id,kind,message_sha256,lamports,last_valid_block_height,reserved_by,epoch_start,token_amount,plan_rows,message_base64,plan_mint,plan_token_program)
      values (${k},'c20',${kind},${H},${lamports},1,'w',to_timestamp(${E}),${tokens},${planRows === null ? null : sql.json(planRows as never)},${msg},${mint},${prog})`;

  beforeAll(async () => {
    sql = postgres(URL!, { max: 25, onnotice: () => {} });
    await sql`insert into public.mcpx_rw_config (id, mint, deployer_wallet) values (1, 'MINT', 'DEPLOYER') on conflict (id) do update set mint='MINT', deployer_wallet='DEPLOYER'`;
    await sql`insert into public.mcpx_rw_fee_events (event_key, signature, ix_index, event_index, source, program_id, mint, recipient, asset, amount, slot, block_time, commitment, status)
      values ('x20:0:0','x20',0,0,'PUMP_CURVE_COLLECT_V2','p','MINT','DEPLOYER','SOL',100000000,1,now(),'finalized','CREDITED') on conflict do nothing`;
    await sql`insert into public.mcpx_rw_epochs (epoch_start) values (to_timestamp(${E})) on conflict do nothing`;
    await sql`insert into public.mcpx_rw_allocations (event_key, epoch_start, receipt_amount, carried_in, holder_sol, buyback, operations, residual_out)
      values ('x20:0:0', to_timestamp(${E}), 100000000, 0, 30000000, 30000000, 40000000, 0)`;
  });
  afterAll(async () => { await sql.end(); });

  it("exact plan (recipients, amounts, message bytes) survives a restart", async () => {
    expect(await intentStore(db, "w1").reserve(base("p20-key-1"))).toBe("NEW");
    await intentStore(db, "w1").recordSigned("p20-key-1", "sig20", "U0lHTkVE");
    const open = (await intentStore(db, "w-restart").openSigned()).find((o) => o.idempotencyKey === "p20-key-1")!;
    expect(open.rows).toEqual(rows);
    const p = (await persistedPlan(db, "p20-key-1"))!;
    expect(p.messageBase64).toBe(MSG); expect(p.rows).toEqual(rows);
  });
  it("plan, message and mint are immutable", async () => {
    await expect(sql`update public.mcpx_rw_intents set plan_rows='[{"owner":"Thief","amount":"1000"}]' where idempotency_key='p20-key-1'`).rejects.toThrow(/immutable/);
    await expect(sql`update public.mcpx_rw_intents set message_base64=${Buffer.from("x").toString("base64")} where idempotency_key='p20-key-1'`).rejects.toThrow(/immutable/);
    await expect(sql`update public.mcpx_rw_intents set plan_mint='OTHER' where idempotency_key='p20-key-1'`).rejects.toThrow(/immutable/);
  });
  it("conflicting signature refused", async () => {
    await expect(sql`update public.mcpx_rw_intents set signature='other' where idempotency_key='p20-key-1'`).rejects.toThrow(/immutable/);
  });
  it("mismatched message bytes refused", async () => {
    await expect(raw("p20-key-bad-msg", "SOL_PAYOUT", [{ owner: "A", amount: "1000" }], Buffer.from("different").toString("base64"))).rejects.toThrow(/does not match/);
  });
  it("payouts without a plan, with wrong totals, duplicates or bad amounts are refused", async () => {
    await expect(raw("p20-key-noplan", "SOL_PAYOUT", null, MSG)).rejects.toThrow(/requires plan_rows/);
    await expect(raw("p20-key-total", "SOL_PAYOUT", [{ owner: "A", amount: "999" }], MSG)).rejects.toThrow(/total/);
    await expect(raw("p20-key-dup", "SOL_PAYOUT", [{ owner: "A", amount: "500" }, { owner: "A", amount: "500" }], MSG)).rejects.toThrow(/unique/);
    await expect(raw("p20-key-neg", "SOL_PAYOUT", [{ owner: "A", amount: "-1000" }], MSG)).rejects.toThrow(/amount/);
    await expect(raw("p20-key-num", "SOL_PAYOUT", [{ owner: "A", amount: 1000 }], MSG)).rejects.toThrow(/amount/);
    await expect(raw("p20-key-tok", "TOKEN_PAYOUT", [{ owner: "A", amount: "5" }], MSG, 0, 5)).rejects.toThrow(/mint and token program/);
    await raw("p20-key-tok-ok", "TOKEN_PAYOUT", [{ owner: "A", amount: "5" }], MSG, 0, 5, "MINT", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });
  it("20 competing workers reserving the same plan: exactly one wins", async () => {
    const r = await Promise.all(Array.from({ length: 20 }, (_, i) => intentStore(db, `w${i}`).reserve(base("p20-key-race"))));
    expect(r.filter((x) => x === "NEW")).toHaveLength(1);
    expect(r.filter((x) => x === "DUPLICATE")).toHaveLength(19);
  });
  it("invalid settlement transitions refused (signed is never paid)", async () => {
    await expect(sql`update public.mcpx_rw_intents set state='LANDED' where idempotency_key='p20-key-race'`).rejects.toThrow();
  });
  it("buyback fills: only LANDED buybacks, recorded once, pending until captured", async () => {
    await sql`insert into public.mcpx_rw_intents (idempotency_key,cycle_id,kind,message_sha256,lamports,last_valid_block_height,reserved_by,epoch_start,token_amount)
      values ('p20-key-buy','c20','BUYBACK',${H},1000000,1,'w',to_timestamp(${E}),0)`;
    await expect(sql`insert into public.mcpx_rw_buyback_fills (signature,intent_key,epoch_start,mint,decimals,token_amount,sol_spent,finalized_slot,evidence)
      values ('buySig','p20-key-buy',to_timestamp(${E}),'MINT',6,10,10,1,'{}')`).rejects.toThrow(/LANDED/);
    await sql`update public.mcpx_rw_intents set state='SIGNED', signature='buySig', signed_tx_base64='QQ==' where idempotency_key='p20-key-buy'`;
    await sql`update public.mcpx_rw_intents set state='LANDED', finalized_slot=9, evidence='{}' where idempotency_key='p20-key-buy'`;
    expect(await pendingFills(db, E)).toBe(1);
    const tx = { slot: 9, transaction: { signatures: ["buySig"], message: { accountKeys: ["DEPLOYER", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "ata"] } },
      meta: { err: null, fee: 5000, preBalances: [10_000_000, 1, 0], postBalances: [9_195_000, 1, 0],
        preTokenBalances: [{ accountIndex: 2, mint: "MINT", owner: "DEPLOYER", uiTokenAmount: { amount: "100" } }],
        postTokenBalances: [{ accountIndex: 2, mint: "MINT", owner: "DEPLOYER", uiTokenAmount: { amount: "777100" } }] } };
    const rpc = async () => tx;
    expect((await captureFills(db, rpc, { deployer: "DEPLOYER", mint: "MINT", decimals: 6 }))[0]!.result).toBe("FILL_RECORDED");
    expect(await captureFills(db, rpc, { deployer: "DEPLOYER", mint: "MINT", decimals: 6 })).toHaveLength(0); // idempotent
    expect(await pendingFills(db, E)).toBe(0);
    const f = (await sql`select token_amount::text t, sol_spent::text s from public.mcpx_rw_buyback_fills where signature='buySig'`)[0]!;
    expect(f["t"]).toBe("777000"); expect(f["s"]).toBe("800000"); // actual delta, not a quote
    const b = (await sql`select tokens::text from public.mcpx_rw_budget_remaining(to_timestamp(${E}))`)[0]!;
    expect(b["tokens"]).toBe("776995"); // fill minus the 5 already reserved token payout
  });
  it("only service_role can reach intents and fills", async () => {
    const g = await sql`select table_name from information_schema.role_table_grants where table_name in ('mcpx_rw_intents','mcpx_rw_buyback_fills') and grantee in ('anon','authenticated')`;
    expect(g).toHaveLength(0);
    const f = await sql`select has_function_privilege('anon','public.mcpx_rw_intent_plan_guard()','execute') a`;
    expect(f[0]!["a"]).toBe(false);
  });
});
