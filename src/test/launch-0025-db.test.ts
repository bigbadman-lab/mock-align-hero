// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with all migrations + pending 0025 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => B[x % 58]).join("");
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const Q = "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs";
const cfg = { catalogVersion: 1, steps: [{ capabilityId: "token.supply", version: 1 }, { capabilityId: "verify.account", version: 1, from: { step: 0, output: "largest_token_account" } }] };

d("0025 launch verifier storage (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(() => { sql = postgres(URL!, { max: 8, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });
  const draft = async (tpl = "canvas") => (await sql`insert into public.mcpx_launch_drafts (creator_wallet, create_key, revision, status, chain_status, template_id, template_version, settings, product_name, token_name, symbol, description, tool_description, canvas_config)
    values (${W}, ${"k" + crypto.randomUUID().replace(/-/g, "")}, 1, 'DRAFT', 'NOT_STARTED', ${tpl}, 1, '{}', 'Prod', 'Tok', 'TOK', 'desc', '', ${tpl === "canvas" ? sql.json(cfg) : null}) returning id`)[0].id;
  const claim = async (draftId: string, mint = b58(44), sig = b58(88)) => (await sql`insert into public.mcpx_cf_launch_claims (draft_id, draft_revision, creator_wallet, mint, signature) values (${draftId}, 1, ${W}, ${mint}, ${sig}) returning id`)[0].id;
  const reg = async (id: string) => (await sql`select public.mcpx_cf_register_launch(${id}, 123, ${Q}, 'ev:1') v`)[0].v as string;

  it("registers a verified Canvas launch atomically: registry + outbox + config + exact Canvas revision", async () => {
    const dr = await draft(); const c = await claim(dr);
    const r = await reg(c);
    expect(r).toMatch(/^registered:/);
    const cid = r.split(":")[1];
    const [cr] = await sql`select template_id, creator_wallet, quote_mint from public.mcp_creations where id = ${cid}`;
    expect([cr.template_id, cr.creator_wallet, cr.quote_mint]).toEqual(["canvas", W, Q]);
    expect((await sql`select 1 from public.outbox_events where aggregate_id = ${cid}`).length).toBe(1);
    expect((await sql`select lifecycle_state from public.mcp_product_configs where creation_id = ${cid}`)[0].lifecycle_state).toBe("active");
    const [v] = await sql`select version, source_draft_id, config from public.mcpx_canvas_product_versions where creation_id = ${cid}`;
    expect([v.version, v.source_draft_id]).toEqual([1, dr]);
    expect(v.config).toEqual(cfg);
    const [ds] = await sql`select status, chain_status from public.mcpx_launch_drafts where id = ${dr}`;
    expect([ds.status, ds.chain_status]).toEqual(["DRAFT", "NOT_STARTED"]); // never marked launched by registration
    expect(await reg(c)).toBe(`already_verified:${cid}`); // idempotent retry
  });
  it("refuses duplicates: same mint, same signature, or a second live claim for the same draft", async () => {
    const dr = await draft(); const mint = b58(44), sig = b58(88);
    await claim(dr, mint, sig);
    await expect(claim(await draft(), mint)).rejects.toThrow(/mint_key|unique/i);
    await expect(claim(await draft(), b58(44), sig)).rejects.toThrow(/signature_key|unique/i);
    await expect(claim(dr)).rejects.toThrow(/one_live|unique/i);
  });
  it("concurrent registration of one claim produces exactly one product", async () => {
    const c = await claim(await draft());
    const rs = await Promise.all(Array.from({ length: 10 }, () => reg(c)));
    expect(rs.filter((x) => x.startsWith("registered:")).length).toBe(1);
    expect(new Set(rs.map((x) => x.split(":")[1])).size).toBe(1);
  });
  it("an edited draft or rejected claim never registers; rejected claims are final", async () => {
    const dr = await draft(); const c = await claim(dr);
    await sql`update public.mcpx_launch_drafts set revision = 2, canvas_config = ${sql.json(cfg)} where id = ${dr}`;
    expect(await reg(c)).toBe("draft_changed");
    expect((await sql`select public.mcpx_cf_reject_launch(${c}, 'SHARES_MISMATCH') v`)[0].v).toBe("rejected");
    expect(await reg(c)).toBe("claim_rejected");
    await expect(sql`update public.mcpx_cf_launch_claims set status = 'PENDING' where id = ${c}`).rejects.toThrow(/final/);
    await expect(sql`delete from public.mcpx_cf_launch_claims where id = ${c}`).rejects.toThrow(/permanent/);
    expect((await sql`select count(*)::int n from public.mcp_creations where child_mint = (select mint from public.mcpx_cf_launch_claims where id = ${c})`)[0].n).toBe(0);
  });
  it("a failed Canvas bind rolls the whole registration back", async () => {
    const dr = await draft(); const c = await claim(dr);
    await sql`alter table public.mcpx_canvas_revisions disable trigger mcpx_canvas_revisions_no_change`;
    await sql`delete from public.mcpx_canvas_revisions where draft_id = ${dr}`;
    await sql`alter table public.mcpx_canvas_revisions enable trigger mcpx_canvas_revisions_no_change`;
    await expect(reg(c)).rejects.toThrow(/canvas_bind_failed:revision_not_found/);
    expect((await sql`select status from public.mcpx_cf_launch_claims where id = ${c}`)[0].status).toBe("PENDING");
    expect((await sql`select count(*)::int n from public.mcp_creations where verified_tx_signature = (select signature from public.mcpx_cf_launch_claims where id = ${c})`)[0].n).toBe(0);
  });
  it("visitors and signed-in users can't read claims or call registration", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); return t`select 1 from public.mcpx_cf_launch_claims`; })).rejects.toThrow(/permission denied/);
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); return t`select public.mcpx_cf_register_launch(gen_random_uuid(), 1, 'x', 'y')`; })).rejects.toThrow(/permission denied/);
    }
  });
});
