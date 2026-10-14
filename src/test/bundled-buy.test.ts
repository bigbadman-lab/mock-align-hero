import { describe, it, expect } from "vitest";
import { bundledBuyFor, MCP_DECIMALS } from "@/lib/tx-builder/launch-gate";

describe("bundled $MCP first buy", () => {
  it("uses 6 decimals and exact-quote-in mode", () => {
    expect(MCP_DECIMALS).toBe(6);
    expect(bundledBuyFor({ amountMcp: "1000", slippageBps: 100 })).toEqual({ mode: "buy_exact_quote_in_v3", quoteAmount: "1000000000", slippageBps: 100 });
    expect(bundledBuyFor({ amountMcp: "0.5", slippageBps: 50 })).toEqual({ mode: "buy_exact_quote_in_v3", quoteAmount: "500000", slippageBps: 50 });
  });
  it("no buy stays no buy", () => { expect(bundledBuyFor(null)).toBeNull(); });
  it("never rounds: more precision than $MCP has is refused", () => {
    expect(bundledBuyFor({ amountMcp: "1.0000001", slippageBps: 100 })).toBe("BUY_AMOUNT_INVALID");
    expect(bundledBuyFor({ amountMcp: "1.000000000", slippageBps: 100 })).toEqual({ mode: "buy_exact_quote_in_v3", quoteAmount: "1000000", slippageBps: 100 });
  });
  it("refuses zero amounts and out-of-range slippage", () => {
    expect(bundledBuyFor({ amountMcp: "0", slippageBps: 100 })).toBe("BUY_AMOUNT_INVALID");
    expect(bundledBuyFor({ amountMcp: "1", slippageBps: 1001 })).toBe("BUY_AMOUNT_INVALID");
  });
});
