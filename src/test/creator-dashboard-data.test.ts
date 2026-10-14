import { describe, expect, it } from "vitest";
import { buildActivity, buildEarnings, buildRewards, decodeActivityCursor, decodeCursor, encodeCursor, pageEarnings, parseMintDecimals, resolveQuoteAsset, WSOL_MINT, type ActivityRow, type CfIntentRow, type OwnedProduct } from "@/lib/creator-dashboard/core";
import type { DistributionRow } from "@/lib/treasury/core";

const ME = "So11111111111111111111111111111111111111112";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const Q = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const P: OwnedProduct = { creationId: "c1", slug: "s", name: "Tool", childMint: MINT, verifiedAt: "2026-10-01T00:00:00Z" };
const intent = (o: Partial<CfIntentRow>): CfIntentRow => ({ idempotency_key: "k1", mint: MINT, status: "LANDED", action: "distribute", signature: "sig", finalized_slot: 10, distributed_amount: "1000", updated_at: "2026-10-02T00:00:00Z", ...o });
const pay = (o: Partial<DistributionRow>): DistributionRow => ({ id: "i:a", windowStart: null, recipient: ME, asset: "SOL", amountRaw: "5", decimals: 9, signature: "s", finalizedSlot: 1, batchId: null, ...o });

describe("creator earnings", () => {
  it("no verified launch → not launched, never zero", () => expect(buildEarnings([], [], [], ME).state).toBe("not_launched"));
  it("launched but no distributions → no activity", () => expect(buildEarnings([P], [{ mint: MINT, quote_mint: Q, creator_wallet: ME }], [], ME).state).toBe("no_activity"));
  it("creator share is 60% of a finalized distribution, deduped by intent key", () => {
    const r = buildEarnings([P], [{ mint: MINT, quote_mint: Q, creator_wallet: ME }], [intent({}), intent({})], ME);
    expect(r.state === "ok" && r.data.rows.length).toBe(1);
    expect(r.state === "ok" && r.data.totals[0]!.creatorShareRaw).toBe("600");
  });
  it("signed-but-unconfirmed distributions are pending, not earnings", () => {
    const r = buildEarnings([P], [{ mint: MINT, quote_mint: Q, creator_wallet: ME }], [intent({ status: "SIGNED" })], ME);
    expect(r.state === "ok" && r.data.rows.length).toBe(0);
    expect(r.state === "ok" && r.data.pendingIntents).toBe(1);
  });
  it("a child registered to another creator is never attributed", () => {
    expect(buildEarnings([P], [{ mint: MINT, quote_mint: Q, creator_wallet: OTHER }], [intent({})], ME).state).toBe("no_activity");
  });
});

describe("native rewards", () => {
  it("before mint → not launched", () => expect(buildRewards(null, [pay({})], ME).state).toBe("not_launched"));
  it("only this wallet's payouts; SOL and $MCP kept separate", () => {
    const r = buildRewards(MINT, [pay({}), pay({ id: "i:b", recipient: OTHER }), pay({ id: "i:c", asset: "MCP", amountRaw: "7", decimals: 6 })], ME);
    expect(r.state === "ok" && [r.data.solRaw, r.data.mcpRaw, r.data.rows.length]).toEqual(["5", "7", 2]);
  });
  it("no payouts → no activity", () => expect(buildRewards(MINT, [pay({ recipient: OTHER })], ME).state).toBe("no_activity"));
});

describe("tool activity", () => {
  it("is reported as not tracked, never as zero runs", () => expect(buildActivity([P]).state).toBe("not_tracked"));
  const act = (o: Partial<ActivityRow>): ActivityRow => ({ id: 1, creation_id: "c1", tool_id: "token_scanner", outcome: "ok", occurred_at: "2026-10-10T00:00:00.000Z", ...o });
  it("when tracking is on, only owned products are shown and failures are kept", () => {
    const r = buildActivity([P], true, [act({}), act({ id: 2, outcome: "error" }), act({ id: 3, creation_id: "other" })]);
    expect(r.state === "ok" && r.data.rows.map((x) => x.outcome)).toEqual(["ok", "error"]);
  });
  it("tracking on with no rows → no activity", () => expect(buildActivity([P], true, []).state).toBe("no_activity"));
  it("pages with a cursor when more rows exist", () => {
    const r = buildActivity([P], true, [act({ id: 3 }), act({ id: 2 }), act({ id: 1 })], 2);
    expect(r.state === "ok" && r.data.nextCursor).toBe("2026-10-10T00:00:00.000Z~2");
    expect(decodeActivityCursor("2026-10-10T00:00:00.000Z~2")).toEqual({ at: "2026-10-10T00:00:00.000Z", id: 2 });
    expect(decodeActivityCursor("x),or(id.gt.0~1")).toBeNull();
  });
});

describe("earnings decimals and paging", () => {
  it("wSOL is 9 decimals as SOL; unknown mints stay raw; $MCP labelled only when official", () => {
    expect(resolveQuoteAsset(WSOL_MINT, null, new Map())).toEqual({ mint: WSOL_MINT, symbol: "SOL", decimals: 9 });
    expect(resolveQuoteAsset(Q, null, new Map()).decimals).toBeNull();
    expect(resolveQuoteAsset(Q, Q, new Map([[Q, 6]]))).toEqual({ mint: Q, symbol: "$MCP", decimals: 6 });
    expect(resolveQuoteAsset(Q, null, new Map([[Q, 6]])).symbol).toBeNull();
  });
  it("decimals only from a real token-program mint account", () => {
    const ok = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6 } } } };
    expect(parseMintDecimals(ok)).toBe(6);
    expect(parseMintDecimals({ ...ok, owner: OTHER })).toBeNull();
    expect(parseMintDecimals({ ...ok, data: { parsed: { type: "account", info: { decimals: 6 } } } })).toBeNull();
    expect(parseMintDecimals(null)).toBeNull();
  });
  it("page returns a cursor only when more exist; pending kept separate from totals", () => {
    const ch = [{ mint: MINT, quote_mint: Q, creator_wallet: ME }];
    const rows = [intent({ idempotency_key: "a", finalized_slot: 30 }), intent({ idempotency_key: "b", finalized_slot: 20 }), intent({ idempotency_key: "c", finalized_slot: 10 })];
    const p = pageEarnings([P], ch, rows, ME, 2, {});
    expect(p.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(p.nextCursor).toBe(encodeCursor(20, "b"));
    expect(decodeCursor(p.nextCursor)).toEqual({ slot: 20, key: "b" });
    expect(decodeCursor('1~a",x')).toBeNull();
    const e = buildEarnings([P], ch, rows, ME, { firstPage: rows, pendingIntents: 4, pageSize: 2, scanLimit: 3 });
    expect(e.state === "ok" && [e.data.totals[0]!.creatorShareRaw, e.data.pendingIntents, e.data.totalsComplete]).toEqual(["1800", 4, false]);
  });
});
