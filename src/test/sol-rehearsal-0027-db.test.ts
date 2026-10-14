// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with all migrations + pending 0027 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => B[x % 58]).join("");
const W = "GJRBYe1nDVszvBDYDjT3Q7DW7fTkdHxaJbL4NvHPqF3p";
const SOL = "So11111111111111111111111111111111111111112";

d("0027 SOL rehearsal permission (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(URL!, { max: 10, onnotice: () => {} });
    expect((await sql`select public.mcpx_sol_rehearsal_grant(${W}) v`)[0].v).toMatch(/granted/);
  });
  afterAll(async () => { await sql.end(); });
  const fn = async (q: any) => (await q)[0].v as string;
  const draft = async () => (await sql`insert into public.mcpx_launch_drafts (creator_wallet, create_key, revision, status, chain_status, template_id, template_version, settings, product_name, token_name, symbol, description, tool_description)
    values (${W}, ${"k" + crypto.randomUUID().replace(/-/g, "")}, 1, 'DRAFT', 'NOT_STARTED', 'wallet-inspector', 1, '{}', 'Prod', 'Tok', 'TOK', 'desc', '') returning id`)[0].id;
  const reserve = (w: string, dr: string, m: string) => fn(sql`select public.mcpx_sol_rehearsal_reserve(${w}, ${dr}, ${m}) v`);
  const release = (reason: string, revoke = false) => fn(sql`select public.mcpx_sol_rehearsal_release(${reason}, ${revoke}) v`);
  const state = async () => (await sql`select status, mint, signature from public.mcpx_sol_rehearsal`)[0];

  it("only one permission can ever exist", async () => {
    expect(await fn(sql`select public.mcpx_sol_rehearsal_grant(${b58(44)}) v`)).toBe("already_granted");
    await expect(sql`insert into public.mcpx_sol_rehearsal (id, creator_wallet) values (1, ${b58(44)})`).rejects.toThrow();
  });
  it("another wallet is never permitted", async () => {
    expect(await reserve(b58(44), await draft(), b58(44))).toBe("not_permitted");
  });
  it("direct writes and deletes are refused", async () => {
    await expect(sql`update public.mcpx_sol_rehearsal set status = 'AVAILABLE'`).rejects.toThrow(/only through/);
    await expect(sql`delete from public.mcpx_sol_rehearsal`).rejects.toThrow(/only through/);
  });
  it("concurrent reservations: exactly one wins, idempotent retry of the winner only", async () => {
    const drafts = await Promise.all(Array.from({ length: 8 }, draft));
    const mints = drafts.map(() => b58(44));
    const rs = await Promise.all(drafts.map((dr, i) => reserve(W, dr, mints[i])));
    expect(rs.filter((x) => x === "reserved").length).toBe(1);
    expect(rs.filter((x) => x === "busy").length).toBe(7);
    const i = rs.indexOf("reserved");
    expect(await reserve(W, drafts[i], mints[i])).toBe("already_reserved");
    expect((await state()).mint).toBe(mints[i]);
  });
  it("failed attempt recovers only via an audited release with a reason", async () => {
    expect(await release("")).toBe("reason_required");
    expect(await release("SIGNING_DECLINED")).toBe("released");
    expect((await state()).status).toBe("AVAILABLE");
    const [e] = await sql`select event, reason from public.mcpx_sol_rehearsal_events where event = 'release'`;
    expect([e.event, e.reason]).toEqual(["release", "SIGNING_DECLINED"]);
    await expect(sql`delete from public.mcpx_sol_rehearsal_events`).rejects.toThrow(/append-only/);
  });
  it("signature binds to the reserved mint; a replay with another signature is refused", async () => {
    const dr = await draft(), mint = b58(44), sig = b58(88);
    expect(await reserve(W, dr, mint)).toBe("reserved");
    expect(await fn(sql`select public.mcpx_sol_rehearsal_submit(${W}, ${b58(44)}, ${sig}) v`)).toBe("mismatch");
    expect(await fn(sql`select public.mcpx_sol_rehearsal_submit(${W}, ${mint}, ${sig}) v`)).toBe("submitted");
    expect(await fn(sql`select public.mcpx_sol_rehearsal_submit(${W}, ${mint}, ${sig}) v`)).toBe("already_submitted");
    expect(await fn(sql`select public.mcpx_sol_rehearsal_submit(${W}, ${mint}, ${b58(88)}) v`)).toBe("mismatch");
    expect(await reserve(W, await draft(), b58(44))).toBe("busy");

    // A product for a different mint can't consume it; the real one can, exactly once, and gets marked.
    const mk = async (m: string, s: string, q = SOL) => (await sql`insert into public.mcp_creations (slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
      values (${"r-" + crypto.randomUUID().slice(0, 8)}, 'wallet-inspector', 1, 'P', 'TOK', 'd', ${W}, ${m}, ${q}, 'solana-mainnet', ${s}, 1, now()) returning id`)[0].id;
    const other = await mk(b58(44), b58(88));
    expect(await fn(sql`select public.mcpx_sol_rehearsal_consume(${other}) v`)).toBe("mismatch");
    const real = await mk(mint, sig);
    const cs = await Promise.all(Array.from({ length: 5 }, () => fn(sql`select public.mcpx_sol_rehearsal_consume(${real}) v`)));
    expect(cs.filter((x) => x === "consumed").length).toBe(1);
    expect(cs.filter((x) => x === "already_consumed").length).toBe(4);
    expect((await sql`select pair_kind from public.mcp_creations where id = ${real}`)[0].pair_kind).toBe("SOL_REHEARSAL");
    expect((await sql`select pair_kind from public.mcp_creations where id = ${other}`)[0].pair_kind).toBe("MCP");
  });
  it("once consumed, no further launch, release or revoke", async () => {
    expect(await reserve(W, await draft(), b58(44))).toBe("used");
    expect(await release("RETRY")).toBe("final");
    expect(await release("CLOSE", true)).toBe("final");
  });
  it("browser roles have no access", async () => {
    for (const role of ["anon", "authenticated"]) {
      const r = await sql`select has_table_privilege(${role}, 'public.mcpx_sol_rehearsal', 'select') t,
        has_table_privilege(${role}, 'public.mcpx_sol_rehearsal_events', 'select') e,
        has_function_privilege(${role}, 'public.mcpx_sol_rehearsal_reserve(text, uuid, text)', 'execute') f`;
      expect([r[0].t, r[0].e, r[0].f]).toEqual([false, false, false]);
    }
  });
});
