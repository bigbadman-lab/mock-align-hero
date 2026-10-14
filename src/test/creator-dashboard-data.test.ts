import { describe, expect, it } from "vitest";
import { buildActivity, buildEarnings, buildRewards, type CfIntentRow, type OwnedProduct } from "@/lib/creator-dashboard/core";
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
});
