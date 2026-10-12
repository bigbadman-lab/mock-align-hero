// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { monitorSupply, percentOf } from "../../services/mcp-worker/src/supply.mjs";
import { isSupplyMonitorResult } from "@/lib/tools/supply-monitor";

const MINT = "So11111111111111111111111111111111111111112";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const A1 = "11111111111111111111111111111111";
const ok = (slot: number, value: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value } }));
const mint = (owner = SPL, supply = "1000", decimals = 2) => ok(10, { owner, data: { parsed: { type: "mint", info: { isInitialized: true, decimals, supply, mintAuthority: null, freezeAuthority: null } } } });
function run(h: { acct?: () => Response; sup?: () => Response; big?: () => Response }) {
  const fetchImpl = async (_u: string, init: RequestInit) => {
    const m = JSON.parse(String(init.body)).method;
    return m === "getAccountInfo" ? (h.acct ?? (() => mint()))() : m === "getTokenSupply" ? (h.sup ?? (() => ok(11, { amount: "1000", decimals: 2 })))() : (h.big ?? (() => ok(12, [{ address: A1, amount: "250", decimals: 2 }])))();
  };
  return monitorSupply({ mint: MINT, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") });
}

describe("Supply Monitor (mock RPC)", () => {
  it("exact percentages floored to 4 decimals; N/A at zero supply", () => {
    expect(percentOf("1", "3")).toBe("33.3333");
    expect(percentOf("18446744073709551615", "18446744073709551615")).toBe("100");
    expect(percentOf("5", "0")).toBeNull();
  });
  it("full snapshot: supply, top accounts, combined share, different slots flagged", async () => {
    const r = await run({});
    expect(r).toMatchObject({ status: "mint", program: "spl-token", decimals: 2, supply: { raw: "1000", ui: "10", slot: 11 }, partial: false, sameSlot: false });
    expect(r.distribution).toMatchObject({ status: "ok", slot: 12, returnedTotalRaw: "250", returnedSharePct: "25", accounts: [{ address: A1, raw: "250", ui: "2.5", sharePct: "25" }] });
    expect(isSupplyMonitorResult(r, MINT)).toBe(true);
  });
  it("Token-2022 and max-u64 amounts stay exact", async () => {
    const max = "18446744073709551615";
    const r = await run({ acct: () => mint(T22, max, 0), sup: () => ok(1, { amount: max, decimals: 0 }), big: () => ok(1, [{ address: A1, amount: max, decimals: 0 }]) });
    expect(r.program).toBe("token-2022");
    expect(r.distribution.accounts[0]).toMatchObject({ raw: max, ui: max, sharePct: "100" });
  });
  it("zero supply gives N/A shares, not a division error", async () => {
    const r = await run({ acct: () => mint(SPL, "0"), sup: () => ok(1, { amount: "0", decimals: 2 }), big: () => ok(1, []) });
    expect(r.supply.raw).toBe("0");
    expect(r.distribution.returnedSharePct).toBeNull();
    expect(isSupplyMonitorResult(r, MINT)).toBe(true);
  });
  it("largest-accounts failure keeps verified supply and is marked partial", async () => {
    const r = await run({ big: () => new Response("x", { status: 429 }) });
    expect(r).toMatchObject({ partial: true, supply: { raw: "1000" }, distribution: { status: "unavailable", reason: "rate_limited", accounts: [] } });
    expect(isSupplyMonitorResult(r, MINT)).toBe(true);
  });
  it("supply failure fails the run (never a fake zero); more than 20 accounts rejected", async () => {
    await expect(run({ sup: () => new Response("x", { status: 500 }) })).rejects.toMatchObject({ kind: "provider_error" });
    const many = Array.from({ length: 21 }, () => ({ address: A1, amount: "1", decimals: 2 }));
    expect((await run({ big: () => ok(1, many) })).distribution.status).toBe("unavailable");
  });
  it("non-mint addresses return no supply", async () => {
    const r = await run({ acct: () => ok(1, null) });
    expect(r).toMatchObject({ status: "not_found", supply: null, distribution: null });
    expect(isSupplyMonitorResult(r, MINT)).toBe(true);
  });
});
