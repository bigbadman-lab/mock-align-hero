// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL_P4 (fresh throwaway Postgres with all migrations + pending 0027).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const URL = process.env["MCPX_TEST_PG_URL_P4"];
const d = URL ? describe : describe.skip;
const B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => B[x % 58]).join("");
const W = "GJRBYe1nDVszvBDYDjT3Q7DW7fTkdHxaJbL4NvHPqF3p";

d("0027 part 4: atomic rehearsal registration (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  const fn = async (q: any) => (await q)[0].v as string;
  let draftId: string, mint: string, sig: string, claim: string;
  beforeAll(async () => {
    sql = postgres(URL!, { max: 10, onnotice: () => {} });
    await sql`select public.mcpx_sol_rehearsal_grant(${W})`;
    draftId = (await sql`insert into public.mcpx_launch_drafts (creator_wallet, create_key, revision, status, chain_status, template_id, template_version, settings, product_name, token_name, symbol, description, tool_description)
      values (${W}, ${"k" + crypto.randomUUID().replace(/-/g, "")}, 1, 'DRAFT', 'NOT_STARTED', 'wallet-inspector', 1, '{}', 'Prod', 'Tok', 'TOK', 'desc', '') returning id`)[0].id;
    mint = b58(44); sig = b58(88);
    expect(await fn(sql`select public.mcpx_sol_rehearsal_reserve(${W}, ${draftId}, ${mint}) v`)).toBe("reserved");
  });
  afterAll(async () => { await sql.end(); });
  const mkClaim = async (m: string, s: string) => (await sql`insert into public.mcpx_cf_launch_claims (draft_id, draft_revision, creator_wallet, mint, signature) values (${draftId}, 1, ${W}, ${m}, ${s}) returning id`)[0].id;
  const reg = (c: string) => fn(sql`select public.mcpx_cf_register_rehearsal(${c}, 42, 'rehearsal:ev') v`);
  const perm = async () => (await sql`select * from public.mcpx_cf_rehearsal_permission()`)[0];

  it("before submission nothing registers", async () => {
    claim = await mkClaim(mint, sig);
    expect(await reg(claim)).toBe("not_rehearsal"); // permission has no signature yet
    expect((await sql`select count(*)::int n from public.mcp_creations`)[0].n).toBe(0);
  });
  it("a released permission is refused once submitted (no second token)", async () => {
    expect(await fn(sql`select public.mcpx_sol_rehearsal_submit(${W}, ${mint}, ${sig}) v`)).toBe("submitted");
    expect(await fn(sql`select public.mcpx_sol_rehearsal_release('RETRY', false) v`)).toBe("submitted_revoke_only");
  });
  it("an unrelated claim is never the rehearsal", async () => {
    const other = await mkClaim(b58(44), b58(88));
    expect(await reg(other)).toBe("not_rehearsal");
  });
  it("concurrent duplicate registrations: one product, permission consumed, marker set", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => reg(claim)));
    expect(rs.filter((x) => x.startsWith("registered:")).length).toBe(1);
    expect(rs.filter((x) => x.startsWith("already_verified:")).length).toBe(4);
    const p = await perm();
    expect(p.status).toBe("CONSUMED");
    const c = (await sql`select pair_kind, quote_mint, child_mint from public.mcp_creations where id = ${p.creation_id}`)[0];
    expect([c.pair_kind, c.quote_mint, c.child_mint]).toEqual(["SOL_REHEARSAL", "So11111111111111111111111111111111111111112", mint]);
    expect((await sql`select count(*)::int n from public.mcp_creations`)[0].n).toBe(1);
    expect((await sql`select count(*)::int n from public.mcp_product_configs`)[0].n).toBe(1);
  });
  it("consumed permission authorises no further launch", async () => {
    expect(await fn(sql`select public.mcpx_sol_rehearsal_reserve(${W}, ${draftId}, ${b58(44)}) v`)).toBe("used");
  });
  it("browser roles cannot call the worker functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      const r = await sql`select has_function_privilege(${role}, 'public.mcpx_cf_register_rehearsal(uuid, bigint, text)', 'execute') a, has_function_privilege(${role}, 'public.mcpx_cf_rehearsal_permission()', 'execute') b`;
      expect([r[0].a, r[0].b]).toEqual([false, false]);
    }
  });
});
