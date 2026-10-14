// @vitest-environment node
// @ts-nocheck -- test-only row access on untyped postgres results
// Runs only with MCPX_TEST_PG_URL (throwaway Postgres with migrations up to 0021 applied).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
const sig = () => bs58.encode(randomBytes(64));
import { childStorePg, loadChildren, pendingRegistry, insertChild } from "../../services/rewards-worker/src/child-store.pg";
import { runChildFeePass, childIntentKey, TOKEN_2022, type ChildRecord, type KeeperDeps, type OnchainChild, type FinalTx } from "../../services/rewards-worker/src/child-fees";
import { guardSql, bind } from "@/lib/rewards/remote";

const URL = process.env["MCPX_TEST_PG_URL"];
const d = URL ? describe : describe.skip;
const k = () => Keypair.generate().publicKey.toBase58();

d("0021 child-fee keeper state (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  // Every statement goes through the same guard + literal binding the sealed bridge uses.
  const db = { query: async (q: string, p: unknown[] = []) => { const g = guardSql(q); if (g) throw new Error(g); return { rows: (await sql.unsafe(bind(q, p))) as any[] }; } };
  const MCP = k(), OPS = k(), PLAT = k(), DEP = k(), KEEPER = DEP;
  const mk = (): ChildRecord => ({ mint: k(), creator: k(), ops: OPS, platform: PLAT, quoteMint: MCP, quoteTokenProgram: TOKEN_2022, sharingConfig: k() });
  const chain = (c: ChildRecord): OnchainChild => ({ sharingConfig: { mint: c.mint, adminRevoked: true, shareholders: [{ address: c.creator, shareBps: 6000 }, { address: OPS, shareBps: 2500 }, { address: PLAT, shareBps: 1500 }] },
    curveCreator: c.sharingConfig, curveQuoteMint: MCP, quoteMintOwner: TOKEN_2022, graduated: false });
  const register = async (c: ChildRecord, creator = c.creator) => {
    await sql`insert into public.mcp_creations (slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
      values (${"s-" + c.mint.slice(0, 12).toLowerCase()}, 'whale-watch', 1, 'T', 'TT', 'd', ${creator}, ${c.mint}, ${MCP}, 'solana-mainnet', ${sig()}, 1, now())`;
    await insertChild(db, c, "1", sig());
  };
  const deps = (c: ChildRecord, over: Partial<KeeperDeps> = {}): KeeperDeps => ({
    now: () => 1_800_000_000, canonicalQuote: MCP, keeper: KEEPER, dailyGasLamports: 1_000_000n, minDistributable: 1n,
    children: async () => (await loadChildren(db)).filter((x) => x.mint === c.mint), readChild: async () => chain(c), balances: async () => ({ curveVaultQuote: 10_000n, ammVaultQuote: 0n }),
    estimateCost: async () => 20_000n, buildAndSign: async () => ({ signature: "sig-tx-" + c.mint, signedBase64: "AQID" + c.mint.slice(0, 8), lastValidBlockHeight: 100 }),
    send: null, fetchFinal: async () => null, finalizedBlockHeight: async () => 50, vaultOwner: () => "VAULT", childByMint: (m) => (m === c.mint ? c : undefined),
    store: childStorePg(db), authorized: { ops: OPS, platform: PLAT, nativeDeployer: DEP },
    registeredCreator: async (m) => (await sql`select creator_wallet from public.mcp_creations where child_mint=${m}`)[0]?.["creator_wallet"] ?? null, ...over,
  });

  beforeAll(() => { sql = postgres(URL!, { max: 25, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });

  it("A1 RLS on, no visitor or signed-in access, server-only privileges", async () => {
    const t = await sql`select relname, relrowsecurity from pg_class where relname in ('mcpx_cf_children','mcpx_cf_intents') order by relname`;
    expect(t.map((x) => x.relrowsecurity)).toEqual([true, true]);
    for (const role of ["anon", "authenticated"]) for (const tb of ["mcpx_cf_children", "mcpx_cf_intents"]) {
      const r = await sql`select has_table_privilege(${role}, ${"public." + tb}, 'SELECT') s, has_table_privilege(${role}, ${"public." + tb}, 'INSERT') i`;
      expect(r[0]).toEqual({ s: false, i: false });
    }
    expect((await sql`select has_table_privilege('service_role','public.mcpx_cf_intents','INSERT') i`)[0]!.i).toBe(true);
  });

  it("A2 bridge guard accepts keeper statements and refuses writes to the registry", () => {
    expect(guardSql("select * from public.mcpx_cf_intents")).toBeNull();
    expect(guardSql("select creator_wallet from public.mcp_creations")).toBeNull();
    expect(guardSql("update public.mcp_creations set creator_wallet='x'")).toBe("SQL_RELATION");
    expect(guardSql("insert into public.mcpx_cf_children select * from public.mcp_creations")).toBe("SQL_RELATION");
    expect(guardSql("select * from public.mcpx_creator_sessions")).toBe("SQL_RELATION");
  });

  it("B1 20 concurrent workers reserve one identity per child window; one open intent per child", async () => {
    const c = mk(); await register(c); const s = childStorePg(db); const key = childIntentKey(c.mint, 1_800_000_000);
    const r = await Promise.all(Array.from({ length: 20 }, () => s.reserve({ key, mint: c.mint, costLamports: 1n })));
    expect(r.filter((x) => x === "RESERVED").length).toBe(1);
    expect(await s.reserve({ key: key + "-other", mint: c.mint, costLamports: 1n })).toBe("DUPLICATE");
  });

  it("B2 identities and signed bytes are immutable; illegal transitions and deletes refused", async () => {
    const c = mk(); await register(c); const s = childStorePg(db); const key = "cf:test:" + c.mint;
    await s.reserve({ key, mint: c.mint, costLamports: 5n });
    await s.recordSigned(key, "SIG1", "BYTES1", 99);
    const row = (await sql`select signature, signed_tx_base64, last_valid_block_height::int h from public.mcpx_cf_intents where idempotency_key=${key}`)[0]!;
    expect(row).toEqual({ signature: "SIG1", signed_tx_base64: "BYTES1", h: 99 }); // exact persistence
    await expect(sql`update public.mcpx_cf_intents set signed_tx_base64='OTHER' where idempotency_key=${key}`).rejects.toThrow(/immutable/);
    await expect(sql`update public.mcpx_cf_intents set cost_lamports=6 where idempotency_key=${key}`).rejects.toThrow(/immutable/);
    await expect(sql`update public.mcpx_cf_intents set mint=${k()} where idempotency_key=${key}`).rejects.toThrow();
    await expect(sql`delete from public.mcpx_cf_intents where idempotency_key=${key}`).rejects.toThrow(/append-only/);
    await expect(s.recordSigned(key, "SIG2", "B2", 1)).rejects.toThrow(/ILLEGAL_TRANSITION/);
    await expect(sql`update public.mcpx_cf_intents set status='RESERVED' where idempotency_key=${key}`).rejects.toThrow(/illegal/);
  });

  it("B3 signed is never paid: LANDED requires finalized slot, amount and evidence; finished rows frozen", async () => {
    const c = mk(); await register(c); const s = childStorePg(db); const key = "cf:land:" + c.mint;
    await s.reserve({ key, mint: c.mint, costLamports: 5n }); await s.recordSigned(key, "S", "B", 9);
    await expect(sql`update public.mcpx_cf_intents set status='LANDED' where idempotency_key=${key}`).rejects.toThrow(/check/i);
    await s.finalize(key, "LANDED", { slot: 123, distributed: "1000" });
    expect((await sql`select status, finalized_slot::int f, distributed_amount::text a from public.mcpx_cf_intents where idempotency_key=${key}`)[0]).toEqual({ status: "LANDED", f: 123, a: "1000" });
    await expect(sql`update public.mcpx_cf_intents set status='FAILED' where idempotency_key=${key}`).rejects.toThrow(/immutable/);
  });

  it("C1 keeper cycle against the database: restart reuses identical bytes and proves settlement on finalized evidence", async () => {
    const c = mk(); await register(c);
    expect(await runChildFeePass(deps(c))).toContainEqual({ mint: c.mint, result: "SIGNED_HELD:DISTRIBUTE" });
    let built = 0;
    const again = await runChildFeePass(deps(c, { buildAndSign: async () => { built++; return { signature: "x", signedBase64: "x", lastValidBlockHeight: 1 }; } }));
    expect(built).toBe(0); expect(again).toContainEqual({ mint: c.mint, result: "SKIP:OPEN_INTENT" });
    const sent: string[] = [];
    await runChildFeePass(deps(c, { send: async (b) => { sent.push(b); } }));
    expect(sent).toEqual(["AQID" + c.mint.slice(0, 8)]); // same bytes after "restart"
    const tx: FinalTx = { finalized: true, err: null, slot: 777, feePayer: KEEPER,
      pre: [{ owner: "VAULT", mint: MCP, amount: 10_000n }, { owner: c.creator, mint: MCP, amount: 0n }, { owner: OPS, mint: MCP, amount: 0n }, { owner: PLAT, mint: MCP, amount: 0n }],
      post: [{ owner: "VAULT", mint: MCP, amount: 0n }, { owner: c.creator, mint: MCP, amount: 6_000n }, { owner: OPS, mint: MCP, amount: 2_500n }, { owner: PLAT, mint: MCP, amount: 1_500n }] };
    expect(await runChildFeePass(deps(c, { fetchFinal: async () => tx }))).toContainEqual({ mint: c.mint, result: "LANDED" });
    expect((await sql`select status, distributed_amount::text a, finalized_slot::int f from public.mcpx_cf_intents where mint=${c.mint}`)[0]).toEqual({ status: "LANDED", a: "10000", f: 777 });
  });

  it("C2 mismatching finalized evidence fails the intent instead of marking it paid", async () => {
    const c = mk(); await register(c);
    await runChildFeePass(deps(c));
    const bad: FinalTx = { finalized: true, err: null, slot: 5, feePayer: KEEPER, pre: [{ owner: "VAULT", mint: MCP, amount: 10_000n }], post: [{ owner: "VAULT", mint: MCP, amount: 0n }, { owner: k(), mint: MCP, amount: 10_000n }] };
    const r = await runChildFeePass(deps(c, { fetchFinal: async () => bad }));
    expect(r.some((x) => x.mint === c.mint && x.result.startsWith("FAILED:"))).toBe(true);
    expect((await sql`select status from public.mcpx_cf_intents where mint=${c.mint}`)[0]!.status).toBe("FAILED");
  });

  it("C3 stale unknown intents expire only past finalized block height", async () => {
    const c = mk(); await register(c);
    await runChildFeePass(deps(c));
    await runChildFeePass(deps(c, { finalizedBlockHeight: async () => 100 }));
    expect((await sql`select status from public.mcpx_cf_intents where mint=${c.mint}`)[0]!.status).toBe("SIGNED");
    await runChildFeePass(deps(c, { finalizedBlockHeight: async () => 101 }));
    expect((await sql`select status from public.mcpx_cf_intents where mint=${c.mint}`)[0]!.status).toBe("EXPIRED");
  });

  it("D1 registry creator mismatch holds with no identity reserved; plan-only mode reserves nothing", async () => {
    const c = mk(); await register(c, k()); // registry creator differs from on-chain 60%
    expect(await runChildFeePass(deps(c))).toContainEqual({ mint: c.mint, result: "HELD:CREATOR_RECIPIENT_MISMATCH" });
    const c2 = mk(); await register(c2);
    const r = await runChildFeePass(deps(c2, { signingEnabled: false }));
    expect(r).toContainEqual({ mint: c2.mint, result: "READY_UNSIGNED:DISTRIBUTE:10000" });
    expect((await sql`select count(*)::int n from public.mcpx_cf_intents where mint in (${c.mint}, ${c2.mint})`)[0]!.n).toBe(0);
  });

  it("D2 gas budget counts today's non-expired intents and onboarding sees only un-onboarded registry rows", async () => {
    expect(await childStorePg(db).gasSpentToday()).toBeGreaterThan(0n);
    const c = mk();
    await sql`insert into public.mcp_creations (slug, template_id, template_version, display_name, ticker, description, creator_wallet, child_mint, quote_mint, network, verified_tx_signature, verified_slot, verified_at)
      values (${"p-" + c.mint.slice(0, 12).toLowerCase()}, 'whale-watch', 1, 'T', 'TT', 'd', ${c.creator}, ${c.mint}, ${MCP}, 'solana-mainnet', ${sig()}, 1, now())`;
    expect((await pendingRegistry(db, MCP)).map((x) => x.child_mint)).toContain(c.mint);
    await expect(sql`insert into public.mcpx_cf_children (mint, creator_wallet, ops_recipient, platform_recipient, quote_mint, quote_token_program, sharing_config, verified_slot, creation_signature) values (${k()}, ${OPS}, ${OPS}, ${PLAT}, ${MCP}, ${TOKEN_2022}, ${k()}, 1, 's')`).rejects.toThrow(/check/i);
  });
});
