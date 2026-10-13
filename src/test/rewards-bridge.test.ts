import { describe, expect, it } from "vitest";
import { seal, verifySeal, guardSql, bind, prepareBatch, remoteDb, SEAL_MAX_SKEW_SECONDS } from "@/lib/rewards/remote";
import { runTx, type Db } from "@/lib/rewards/store.pg";
import { deriveLaunch } from "../../services/rewards-worker/src/launch-derive";

const SECRET = "a".repeat(40);
const P = "/api/public/rewards/exec";
const hdr = (h: Record<string, string>) => ({ ts: h["x-mcpx-rw-ts"]!, nonce: h["x-mcpx-rw-nonce"]!, sig: h["x-mcpx-rw-sig"]! });

describe("rewards bridge seal", () => {
  it("accepts a correctly sealed body", async () => {
    const h = await seal(SECRET, "POST", P, '{"x":1}');
    expect((await verifySeal(SECRET, "POST", P, '{"x":1}', hdr(h))).ok).toBe(true);
  });
  it("rejects the wrong secret", async () => {
    const h = await seal("b".repeat(40), "POST", P, "{}");
    expect(await verifySeal(SECRET, "POST", P, "{}", hdr(h))).toEqual({ ok: false, reason: "BAD_SEAL" });
  });
  it("rejects an altered body", async () => {
    const h = await seal(SECRET, "POST", P, '{"x":1}');
    expect((await verifySeal(SECRET, "POST", P, '{"x":2}', hdr(h))).ok).toBe(false);
  });
  it("rejects a seal for another address", async () => {
    const h = await seal(SECRET, "POST", "/api/public/rewards/state", "{}");
    expect((await verifySeal(SECRET, "POST", P, "{}", hdr(h))).ok).toBe(false);
  });
  it("rejects a seal older than 5 minutes", async () => {
    const now = 1_800_000_000;
    const h = await seal(SECRET, "POST", P, "{}", now - SEAL_MAX_SKEW_SECONDS - 1);
    expect(await verifySeal(SECRET, "POST", P, "{}", hdr(h), now)).toEqual({ ok: false, reason: "STALE" });
  });
  it("refuses everything when the site secret is missing", async () => {
    const h = await seal(SECRET, "POST", P, "{}");
    expect((await verifySeal("", "POST", P, "{}", hdr(h))).ok).toBe(false);
  });
});

describe("rewards bridge statement guard", () => {
  it("allows rewards tables only", () => {
    expect(guardSql("select * from public.mcpx_rw_hix_holds where mint=$1")).toBeNull();
    expect(guardSql("select * from public.mcpx_creations")).toBe("SQL_RELATION");
    expect(guardSql("select * from auth.users")).toBe("SQL_DENIED");
    expect(guardSql("delete from public.mcpx_rw_hix_holds; drop table x")).toBe("SQL_DENIED");
    expect(guardSql("begin")).toBe("SQL_KIND");
  });
  it("binds parameters as quoted literals in one pass", () => {
    expect(bind("select $1, $2, $10", ["it's", null, ...Array(7).fill(0), "$1"])).toBe("select 'it''s', NULL, '$1'");
  });
  it("rejects bad batches", () => {
    expect(() => prepareBatch([])).toThrow("BATCH_SIZE");
    expect(() => prepareBatch([{ sql: "select * from public.users" }])).toThrow("SQL_RELATION");
  });
});

describe("atomic batches", () => {
  it("rolls back the whole batch when a check step returns nothing", async () => {
    const log: string[] = [];
    const db: Db = { async query(t) { log.push(t.split(" ")[0]!); return { rows: t.startsWith("update") ? [] : [{}] }; } };
    const r = await runTx(db, [{ sql: "insert a" }, { sql: "update b", abortIfEmpty: "STALE" }, { sql: "insert c" }]);
    expect(r.aborted).toBe("STALE");
    expect(log).toEqual(["begin", "insert", "update", "rollback"]);
  });
  it("remote store sends a transaction as ONE sealed request", async () => {
    const calls: { url: string; body: any; headers: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ ok: true, aborted: null, results: [] })); }) as unknown as typeof fetch;
    const db = remoteDb({ siteUrl: "https://mcpx.fun", secret: SECRET, fetchImpl });
    await runTx(db, [{ sql: "insert into public.mcpx_rw_hix_gaps values ($1)", params: [5n as unknown as string] }, { sql: "select 1" }]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.steps.length).toBe(2);
    expect(calls[0]!.body.steps[0].params[0]).toBe("5");
    expect(calls[0]!.headers["x-mcpx-rw-sig"]).toMatch(/^[0-9a-f]{64}$/);
    await expect(db.query("begin")).rejects.toThrow();
  });
});

describe("mint is the single go-live input", () => {
  it("derives anchor slot, genesis window and deployer from the creation transaction", async () => {
    const rpc = async (m: string) => m === "getSignaturesForAddress" ? [{ signature: "new", slot: 200 }, { signature: "create", slot: 100 }]
      : { slot: 100, blockTime: 1_800_000_123, transaction: { message: { accountKeys: ["Deployer1111"] } } };
    expect(await deriveLaunch(rpc, "Mint")).toEqual({ anchorSlot: 99, genesisWindow: 1_800_000_000, deployer: "Deployer1111", signature: "create" });
  });
  it("never guesses when history can't be read", async () => {
    expect(await deriveLaunch(async () => { throw new Error("x"); }, "Mint")).toBeNull();
  });
});
