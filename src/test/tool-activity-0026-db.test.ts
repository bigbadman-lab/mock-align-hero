// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with mcp_creations + pending 0026 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;

d("0026 tool activity (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let c: string;
  beforeAll(async () => {
    sql = postgres(URL!, { max: 4, onnotice: () => {} });
    c = (await sql`insert into public.mcp_creations (slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
      values (${"s" + crypto.randomUUID().slice(0, 8)}, 'token-scanner', 1, 'C', 'CC', 'd', 'W', ${crypto.randomUUID()}, 'Q', 'solana-mainnet', 'sig', 1, now()) returning id`)[0].id;
  });
  afterAll(async () => { await sql.end(); });
  const rec = (ref: string, outcome = "ok", creation = c) => sql`select public.mcpx_tool_activity_record(${creation}, 'token_scanner', ${outcome}, ${ref}) v`.then((r) => r[0].v);

  it("records once per execution ref (retry never duplicates)", async () => {
    const ref = crypto.randomUUID();
    expect(await rec(ref)).toBe("recorded");
    expect(await rec(ref)).toBe("duplicate");
    expect((await sql`select count(*)::int n from public.mcpx_tool_activity where execution_ref = ${ref}`)[0].n).toBe(1);
  });
  it("records failures; rejects unknown outcome and unknown product", async () => {
    expect(await rec(crypto.randomUUID(), "error")).toBe("recorded");
    expect(await rec(crypto.randomUUID(), "maybe")).toBe("bad_outcome");
    expect(await rec(crypto.randomUUID(), "ok", crypto.randomUUID())).toBe("unknown_product");
  });
  it("purges rows older than 90 days and keeps recent ones", async () => {
    await sql`insert into public.mcpx_tool_activity (creation_id, tool_id, outcome, execution_ref, occurred_at) values (${c}, 'token_scanner', 'ok', ${crypto.randomUUID()}, now() - interval '91 days')`;
    expect(await sql`select public.mcpx_tool_activity_purge(1000) n`.then((r) => r[0].n)).toBe(1);
    expect((await sql`select count(*)::int n from public.mcpx_tool_activity where occurred_at < now() - interval '90 days'`)[0].n).toBe(0);
    expect((await sql`select count(*)::int n from public.mcpx_tool_activity`)[0].n).toBe(2);
  });
  it("browser roles have no access to the table or functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); await t`select * from public.mcpx_tool_activity`; })).rejects.toThrow(/permission denied/);
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); await t`select public.mcpx_tool_activity_record(${c}, 'x', 'ok', ${crypto.randomUUID()})`; })).rejects.toThrow(/permission denied/);
    }
  });
  it("dashboard query uses the product index", async () => {
    const plan = await sql.begin(async (t) => { await t.unsafe("set local enable_seqscan = off");
      return (await t.unsafe(`explain select id from public.mcpx_tool_activity where creation_id = '${c}' order by occurred_at desc, id desc limit 21`)).map((r) => r["QUERY PLAN"]).join("\n"); });
    expect(plan).toMatch(/mcpx_tool_activity_by_product/);
  });
});
