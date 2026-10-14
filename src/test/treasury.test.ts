import { describe, expect, it } from "vitest";
import { countdown, deriveWindowStatus, formatUnits, nextBoundary, payoutRows, splitNative, windowLabel, WINDOW_MS, type IntentLike } from "@/lib/treasury/core";
import { pickMarket } from "@/lib/treasury/market.server";
import { cached } from "@/lib/treasury/source.server";

const MINT = "So11111111111111111111111111111111111111112";
const OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const W1 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIG = "5".repeat(88);
const intent = (o: Partial<IntentLike>): IntentLike => ({ idempotency_key: "k1", kind: "SOL_PAYOUT", state: "LANDED", signature: SIG, finalized_slot: 100, evidence: { ok: 1 }, epoch_start: "2026-10-14T10:00:00Z", plan_rows: [{ owner: W1, amount: "1000" }], plan_mint: null, batch_id: null, ...o });

describe("treasury windows", () => {
  const t = Date.UTC(2026, 9, 14, 10, 7, 30);
  it("prelaunch is Not launched", () => expect(deriveWindowStatus({ mint: null, now: t, heartbeatAt: t, lastProcessedWindow: t })).toBe("NOT_LAUNCHED"));
  it("no processing yet is Awaiting data", () => expect(deriveWindowStatus({ mint: MINT, now: t, heartbeatAt: null, lastProcessedWindow: null })).toBe("AWAITING_DATA"));
  it("stale heartbeat is Delayed", () => expect(deriveWindowStatus({ mint: MINT, now: t, heartbeatAt: t - 16 * 60_000, lastProcessedWindow: t - WINDOW_MS })).toBe("DELAYED"));
  it("boundary just passed and window not yet processed is Processing, never paid", () => {
    const now = Date.UTC(2026, 9, 14, 10, 10, 1);
    expect(deriveWindowStatus({ mint: MINT, now, heartbeatAt: now, lastProcessedWindow: Date.UTC(2026, 9, 14, 10, 0) })).toBe("PROCESSING");
  });
  it("countdown uses server offset (clock skew) and aligns to UTC 5-minute boundaries", () => {
    expect(nextBoundary(t)).toBe(Date.UTC(2026, 9, 14, 10, 10));
    const c = countdown(60_000, t - 60_000); // client clock 1 min behind
    expect(`${c.mm}:${c.ss}`).toBe("02:30");
  });
});

describe("treasury accounting", () => {
  it("30/30/40 split conserves every lamport", () => {
    const s = splitNative(1_000_000_007n);
    expect(s.holderSol).toBe(300_000_002n);
    expect(s.buyback).toBe(300_000_002n);
    expect(s.holderSol + s.buyback + s.operations).toBe(1_000_000_007n);
  });
  it("formats integer units without floats", () => expect(formatUnits("1234500000", 9)).toBe("1.2345"));
  it("zero-fee window says so", () => expect(windowLabel("PLANNED", [], "0")).toBe("No eligible collected fees this window"));
});

describe("finalized payout feed", () => {
  it("only LANDED intents with finalized slot and evidence appear", () => {
    const rows = payoutRows([intent({}), intent({ idempotency_key: "k2", state: "SIGNED" }), intent({ idempotency_key: "k3", evidence: null }), intent({ idempotency_key: "k4", finalized_slot: null })], { mint: MINT, tokenDecimals: 6 });
    expect(rows.map((r) => r.id)).toEqual([`k1:${W1}`]);
  });
  it("duplicates are suppressed by durable identity", () => expect(payoutRows([intent({}), intent({})], { mint: MINT, tokenDecimals: 6 })).toHaveLength(1));
  it("token payouts of another mint (rehearsal) never show as $MCP", () => {
    expect(payoutRows([intent({ kind: "TOKEN_PAYOUT", plan_mint: OTHER })], { mint: MINT, tokenDecimals: 6 })).toHaveLength(0);
    const r = payoutRows([intent({ kind: "TOKEN_PAYOUT", plan_mint: MINT })], { mint: MINT, tokenDecimals: 6 });
    expect(r[0]).toMatchObject({ asset: "MCP", decimals: 6 });
  });
  it("SOL rows use 9 decimals", () => expect(payoutRows([intent({})], { mint: MINT, tokenDecimals: 6 })[0]!.decimals).toBe(9));
});

describe("market data", () => {
  it("uses only pairs whose base token is the exact mint and keeps FDV separate", () => {
    const m = pickMarket(MINT, [{ baseToken: { address: OTHER }, priceUsd: "9", volume: { h24: 999 }, fdv: 1 }, { baseToken: { address: MINT }, priceUsd: "0.01", volume: { h24: 50 }, fdv: 1000, liquidity: { usd: 5 } }], "t");
    expect(m).toMatchObject({ priceUsd: "0.01", volume24hUsd: 50, fdvUsd: 1000, marketCapUsd: null, pairCount: 1 });
  });
  it("ticker-only match yields no market", () => expect(pickMarket(MINT, [{ baseToken: { address: OTHER } }], "t")).toBeNull());
});

describe("reader load", () => {
  it("100 concurrent readers share one backend read", async () => {
    let calls = 0;
    const r = await Promise.all(Array.from({ length: 100 }, () => cached("t-load", 10_000, async () => { calls++; await new Promise((x) => setTimeout(x, 10)); return 1; })));
    expect(calls).toBe(1);
    expect(r.every((x) => x === 1)).toBe(true);
  });
});

import { pickBirdeye } from "@/lib/treasury/market.server";
describe("birdeye market", () => {
  const A = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  it("maps exact-mint overview", () => {
    const m = pickBirdeye(A, { success: true, data: { address: A, price: 0.5, marketCap: 10, fdv: 20, v24hUSD: 3, liquidity: 4, holder: 7, numberMarkets: 2 } }, "t");
    expect(m).toMatchObject({ source: "birdeye", priceUsd: "0.5", marketCapUsd: 10, fdvUsd: 20, volume24hUsd: 3, holders: 7 });
  });
  it("rejects a different mint", () => expect(pickBirdeye(A, { success: true, data: { address: "x", price: 1 } }, "t")).toBeNull());
});
