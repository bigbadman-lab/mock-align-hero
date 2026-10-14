// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres, migrations through 0022 + pending 0023 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const cfg = { catalogVersion: 1, steps: [{ capabilityId: "token.supply", version: 1 }, { capabilityId: "verify.account", version: 1, from: { step: 0, output: "largest_token_account" } }] };

d("0023 Canvas drafts (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(() => { sql = postgres(URL!, { max: 4, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });
  const ins = (tpl: string, c: unknown, wallet = "W1") => sql`insert into public.mcpx_launch_drafts (creator_wallet, create_key, revision, status, chain_status, template_id, template_version, settings, product_name, token_name, symbol, description, tool_description, canvas_config)
    values (${wallet}, ${"k" + Math.random()}, 1, 'DRAFT', 'NOT_STARTED', ${tpl}, 1, '{}', 'P', 'T', 'TT', 'd', '', ${c === null ? null : sql.json(c)}) returning id`;

  it("canvas drafts require a config; other templates must not have one", async () => {
    await expect(ins("canvas", null)).rejects.toThrow(/canvas_shape/);
    await expect(ins("token-scanner", cfg)).rejects.toThrow(/canvas_shape/);
    await expect(ins("canvas", { catalogVersion: 1, steps: [cfg.steps[0]] })).rejects.toThrow(/canvas_shape/);
    await expect(ins("canvas", { catalogVersion: 1, steps: Array(5).fill(cfg.steps[0]) })).rejects.toThrow(/canvas_shape/);
    expect((await ins("token-scanner", null)).length).toBe(1);
  });
  it("each saved revision is recorded once and is immutable", async () => {
    const [{ id }] = await ins("canvas", cfg);
    await sql`update public.mcpx_launch_drafts set revision = 2, canvas_config = ${sql.json({ ...cfg, steps: [cfg.steps[0], cfg.steps[1]] })} where id = ${id}`;
    await sql`update public.mcpx_launch_drafts set status = 'DRAFT' where id = ${id}`; // same revision: no new history row
    const h = await sql`select draft_revision, creator_wallet from public.mcpx_canvas_revisions where draft_id = ${id} order by 1`;
    expect(h.map((r) => r.draft_revision)).toEqual([1, 2]);
    expect(h[0].creator_wallet).toBe("W1");
    await expect(sql`update public.mcpx_canvas_revisions set config = '{}' where draft_id = ${id}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from public.mcpx_canvas_revisions where draft_id = ${id}`).rejects.toThrow(/immutable/);
  });
  it("visitors and signed-in users can't read drafts or history", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); return t`select 1 from public.mcpx_canvas_revisions`; })).rejects.toThrow(/permission denied/);
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); return t`select 1 from public.mcpx_launch_drafts`; })).rejects.toThrow(/permission denied/);
    }
  });
  it("existing non-canvas rows stay valid (additive)", async () => {
    const [{ n }] = await sql`select count(*)::int n from public.mcpx_launch_drafts where template_id <> 'canvas' and canvas_config is not null`;
    expect(n).toBe(0);
  });
});
