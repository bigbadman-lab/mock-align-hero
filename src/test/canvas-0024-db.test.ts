// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with all migrations + pending 0024 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const W = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER = "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs";
const cfg = { catalogVersion: 1, steps: [{ capabilityId: "token.supply", version: 1 }, { capabilityId: "verify.account", version: 1, from: { step: 0, output: "largest_token_account" } }] };

d("0024 Canvas products (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(() => { sql = postgres(URL!, { max: 8, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });
  const draft = async (wallet = W) => (await sql`insert into public.mcpx_launch_drafts (creator_wallet, create_key, revision, status, chain_status, template_id, template_version, settings, product_name, token_name, symbol, description, tool_description, canvas_config)
    values (${wallet}, ${"k" + crypto.randomUUID().replace(/-/g, "")}, 1, 'DRAFT', 'NOT_STARTED', 'canvas', 1, '{}', 'P', 'T', 'TT', 'd', '', ${sql.json(cfg)}) returning id, status`)[0];
  const creation = async (tpl: string, wallet = W) => (await sql`insert into public.mcp_creations (slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
    values (${"s" + crypto.randomUUID().slice(0, 8)}, ${tpl}, 1, 'C', 'CC', 'd', ${wallet}, ${"M" + crypto.randomUUID().replace(/-/g, "")}, 'Q', 'solana-mainnet', ${"sig" + crypto.randomUUID()}, 1, now()) returning id`)[0].id;
  const bind = async (c: string, dr: string, r = 1) => (await sql`select public.mcpx_canvas_bind(${c}, ${dr}, ${r}) v`)[0].v;
  const put = async (c: string, w: string, e: number) => (await sql`select public.mcpx_canvas_put_version(${c}, ${w}, ${sql.json(cfg)}, 1, ${e}) v`)[0].v;

  it("registry accepts canvas and still accepts existing templates; rejects unknown", async () => {
    expect(await creation("canvas")).toBeTruthy();
    expect(await creation("token-scanner")).toBeTruthy();
    await expect(creation("made-up")).rejects.toThrow(/template_id_check/);
  });
  it("binds only to a verified canvas creation of the same creator, from a saved revision", async () => {
    const dr = await draft();
    expect(await bind(crypto.randomUUID(), dr.id)).toBe("not_verified");
    expect(await bind(await creation("token-scanner"), dr.id)).toBe("not_canvas");
    expect(await bind(await creation("canvas", OTHER), dr.id)).toBe("creator_mismatch");
    const c = await creation("canvas");
    expect(await bind(c, dr.id, 9)).toBe("revision_not_found");
    expect(await bind(c, dr.id)).toBe("bound");
    expect(await bind(c, dr.id)).toBe("already_bound");
    const dr2 = await draft();
    expect(await bind(c, dr2.id)).toBe("bound_to_other");
    // Binding never changes the draft's status or chain status.
    const [row] = await sql`select status, chain_status from public.mcpx_launch_drafts where id = ${dr.id}`;
    expect([row.status, row.chain_status]).toEqual(["DRAFT", "NOT_STARTED"]);
  });
  it("versions append with optimistic concurrency, only by the creator, and are immutable", async () => {
    const dr = await draft(); const c = await creation("canvas");
    expect(await put(c, W, 1)).toBe("not_bound");
    await bind(c, dr.id);
    expect(await put(c, OTHER, 1)).toBe("not_found");
    const race = await Promise.all(Array.from({ length: 10 }, () => put(c, W, 1)));
    expect(race.filter((x) => x === "ok:2").length).toBe(1);
    expect(race.filter((x) => x === "stale_version").length).toBe(9);
    await expect(sql`update public.mcpx_canvas_product_versions set config = '{}' where creation_id = ${c}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from public.mcpx_canvas_product_versions where creation_id = ${c}`).rejects.toThrow(/immutable/);
  });
  it("visitors and signed-in users can't read versions or call the functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); return t`select 1 from public.mcpx_canvas_product_versions`; })).rejects.toThrow(/permission denied/);
      await expect(sql.begin(async (t) => { await t.unsafe(`set local role ${role}`); return t`select public.mcpx_canvas_bind(gen_random_uuid(), gen_random_uuid(), 1)`; })).rejects.toThrow(/permission denied/);
    }
  });
});
