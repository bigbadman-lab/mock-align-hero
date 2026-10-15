// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { holderIntelligence, MAX_RPC_CALLS } from "../../services/mcp-worker/src/holders.mjs";
// @ts-expect-error plain JS worker module
import { tokenRiskAnalyst } from "../../services/mcp-worker/src/risk.mjs";
import { isHolderIntelligenceResult } from "@/lib/tools/holder-intelligence";
import { isTokenRiskResult } from "@/lib/tools/token-risk-analyst";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
import { freeTestBucket, FREE_TESTS_PER_DAY, bucketsFor } from "@/lib/tools/relay";
import { LIBRARY } from "@/lib/templates";

const MINT = "So11111111111111111111111111111111111111112";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYS = "11111111111111111111111111111111";
const A1 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const A2 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const A3 = "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy";
const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const MAX = "18446744073709551615";

const ok = (slot: number, value: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value } }));
const mintAcct = (o: { program?: string; supply?: string; decimals?: number; mintAuthority?: string | null; freezeAuthority?: string | null; extensions?: unknown[] } = {}) =>
  ok(10, { owner: o.program ?? SPL, data: { parsed: { type: "mint", info: { isInitialized: true, decimals: o.decimals ?? 2, supply: o.supply ?? "1000", mintAuthority: o.mintAuthority ?? null, freezeAuthority: o.freezeAuthority ?? null, ...(o.extensions ? { extensions: o.extensions } : {}) } } } });
const tokAcct = (owner: string, mint = MINT) => ({ owner: SPL, data: { parsed: { type: "account", info: { mint, owner, state: "initialized", tokenAmount: { amount: "1", decimals: 2 } } } } });

type H = Partial<Record<"acct" | "sup" | "big" | "accs" | "owners", () => Response>>;
function rpc(h: H, supply = "1000", decimals = 2) {
  const calls: string[] = [];
  const fetchImpl = async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    calls.push(b.method);
    if (b.method === "getAccountInfo") return (h.acct ?? (() => mintAcct({ supply, decimals })))();
    if (b.method === "getTokenSupply") return (h.sup ?? (() => ok(11, { amount: supply, decimals })))();
    if (b.method === "getTokenLargestAccounts") return (h.big ?? (() => ok(12, [{ address: A1, amount: "500", decimals }, { address: A2, amount: "200", decimals }, { address: A3, amount: "100", decimals }])))();
    if (b.params[1].encoding === "jsonParsed") return (h.accs ?? (() => ok(13, [tokAcct(OWNER), tokAcct(OWNER), null])))();
    return (h.owners ?? (() => ok(14, b.params[0].map(() => ({ owner: SYS, lamports: 1, data: ["", "base64"] })))))();
  };
  return { calls, fetchImpl };
}
const HI = (h: H = {}, supply?: string, decimals?: number) => { const r = rpc(h, supply, decimals); return holderIntelligence({ mint: MINT, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl: r.fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") }).then((o: Record<string, unknown>) => ({ o, calls: r.calls })); };
const TRA = (h: H = {}) => { const r = rpc(h); return tokenRiskAnalyst({ mint: MINT, rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl: r.fetchImpl, now: () => new Date("2026-01-01T00:00:00Z") }).then((o: Record<string, unknown>) => ({ o, calls: r.calls })); };
const item = (o: Record<string, unknown>, id: string) => (o["checklist"] as { id: string; state: string }[]).find((i) => i.id === id)!.state;

describe("Holder Intelligence (mock RPC)", () => {
  it("aggregates two token accounts of one owner, flags closed account, discloses largest-accounts-only coverage", async () => {
    const { o, calls } = await HI();
    const d = o["distribution"] as any;
    expect(d.owners).toEqual([expect.objectContaining({ owner: OWNER, tokenAccounts: 2, raw: "700", sharePct: "70", ownerKind: "system_account", onCurve: true })]);
    expect(d.accounts[2]).toMatchObject({ address: A3, owner: null, ownerStatus: "missing" });
    expect(d.coverage).toMatchObject({ population: "largest_token_accounts", completeHolderSet: false, uniqueHolderCount: null, observedAccounts: 3, ownersResolved: 2, ownersUnresolved: 1 });
    expect(d.concentration).toMatchObject({ largestAccountPct: "50", top5AccountsPct: "80", largestObservedOwnerPct: "70" });
    expect(o["partial"]).toBe(true); // an unresolved owner is disclosed, not hidden
    expect(calls.length).toBeLessThanOrEqual(MAX_RPC_CALLS);
    expect(isHolderIntelligenceResult(o, MINT)).toBe(true);
  });
  it("unresolved owner when token account belongs to another mint", async () => {
    const { o } = await HI({ accs: () => ok(13, [tokAcct(OWNER, A2), tokAcct(OWNER), tokAcct(OWNER)]) });
    expect((o["distribution"] as any).accounts[0].ownerStatus).toBe("unresolved");
  });
  it("Token-2022 with max u64 amounts stays exact", async () => {
    const { o } = await HI({ acct: () => mintAcct({ program: T22, supply: MAX, decimals: 0 }), big: () => ok(1, [{ address: A1, amount: MAX, decimals: 0 }]), accs: () => ok(1, [tokAcct(OWNER)]) }, MAX, 0);
    expect(o["program"]).toBe("token-2022");
    expect((o["distribution"] as any).accounts[0]).toMatchObject({ raw: MAX, ui: MAX, sharePct: "100" });
    expect(isHolderIntelligenceResult(o, MINT)).toBe(true);
  });
  it("zero supply → shares N/A", async () => {
    const { o } = await HI({ big: () => ok(1, []) }, "0");
    expect((o["distribution"] as any).concentration.largestAccountPct).toBeNull();
    expect(isHolderIntelligenceResult(o, MINT)).toBe(true);
  });
  it("missing account and non-token program return no distribution", async () => {
    expect((await HI({ acct: () => ok(1, null) })).o).toMatchObject({ status: "not_found", distribution: null });
    expect((await HI({ acct: () => ok(1, { owner: SYS, data: ["", "base64"] }) })).o).toMatchObject({ status: "not_token_program" });
  });
  it("malformed mint rejected with stable code", async () => {
    await expect(holderIntelligence({ mint: "nope", rpcUrl: "x", executionId: "x" })).rejects.toMatchObject({ kind: "invalid_input" });
  });
  it("largest-accounts rate limit → partial with stable reason; supply failure fails run", async () => {
    const { o } = await HI({ big: () => new Response("x", { status: 429 }) });
    expect(o).toMatchObject({ partial: true, distribution: { status: "unavailable", reason: "rate_limited" } });
    expect(isHolderIntelligenceResult(o, MINT)).toBe(true);
    await expect(HI({ sup: () => new Response("x", { status: 500 }) })).rejects.toMatchObject({ kind: "provider_error" });
  });
  it("owner-lookup failure keeps balances and marks partial", async () => {
    const { o } = await HI({ accs: () => new Response("x", { status: 503 }) });
    expect(o).toMatchObject({ partial: true });
    expect((o["distribution"] as any).owners).toEqual([]);
  });
  it("validator rejects a claimed complete holder set", async () => {
    const { o } = await HI();
    (o["distribution"] as any).coverage.completeHolderSet = true;
    expect(isHolderIntelligenceResult(o, MINT)).toBe(false);
  });
});

describe("Token Risk Analyst (mock RPC)", () => {
  it("authorities present → observed; SPL extensions not applicable; skips owner lookups", async () => {
    const { o, calls } = await TRA({ acct: () => mintAcct({ mintAuthority: OWNER, freezeAuthority: OWNER }) });
    expect([item(o, "mint_authority"), item(o, "freeze_authority"), item(o, "permanent_delegate")]).toEqual(["observed", "observed", "not_applicable"]);
    expect(item(o, "largest_account_concentration")).toBe("observed"); // 50% ≥ 20%
    expect(calls).toEqual(expect.not.arrayContaining(["getMultipleAccounts"]));
    expect(o["summary"]).toMatchObject({ score: null, complete: true });
    expect(isTokenRiskResult(o, MINT)).toBe(true);
  });
  it("authorities absent → not observed", async () => {
    const { o } = await TRA();
    expect([item(o, "mint_authority"), item(o, "freeze_authority")]).toEqual(["not_observed", "not_observed"]);
  });
  it("Token-2022: decoded extensions observed; undecodable → unknown, summary incomplete", async () => {
    const { o } = await TRA({ acct: () => mintAcct({ program: T22, extensions: [{ extension: "permanentDelegate", state: { delegate: OWNER } }, { extension: "unparseableExtension" }] }) });
    expect(item(o, "permanent_delegate")).toBe("observed");
    expect(item(o, "transfer_hook")).toBe("unknown"); // absent but list incomplete → unknown, never "not observed"
    expect(item(o, "undecoded_extensions")).toBe("observed");
    expect(o["summary"]).toMatchObject({ complete: false });
    expect(isTokenRiskResult(o, MINT)).toBe(true);
  });
  it("distribution unavailable → concentration unknown, never reassuring", async () => {
    const { o } = await TRA({ big: () => new Response("x", { status: 429 }) });
    expect(item(o, "top10_concentration")).toBe("unknown");
    expect((o["summary"] as any).complete).toBe(false);
  });
  it("validator refuses a summary that hides unknowns", async () => {
    const { o } = await TRA({ big: () => new Response("x", { status: 429 }) });
    (o["summary"] as any).complete = true;
    expect(isTokenRiskResult(o, MINT)).toBe(false);
  });
  it("provider timeout surfaces as stable error kind", async () => {
    const fetchImpl = async () => { throw new Error("x"); };
    await expect(tokenRiskAnalyst({ mint: MINT, rpcUrl: "x", executionId: "x", fetchImpl })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("L5 integration rules", () => {
  it("MCP adapters exist with mint-only input and no product settings", () => {
    for (const id of ["holder-intelligence", "token-risk-analyst"]) {
      const a = ADAPTERS[id]!;
      expect(a.inputSchema.safeParse({ mint: MINT }).success).toBe(true);
      expect(a.inputSchema.safeParse({ mint: MINT, extra: 1 }).success).toBe(false);
      expect(a.parseSettings({ x: 1 })).toBeNull();
      expect(JSON.parse(a.toWorkerPayload({ mint: MINT }, {})).input).toEqual({ mint: MINT });
    }
  });
  it("free tests: 3 per tool per day in UTC-aligned day windows, separate per tool, not in shared buckets", () => {
    expect(FREE_TESTS_PER_DAY).toBe(500);
    expect(freeTestBucket("holder_intelligence", "v")).toEqual({ bucket: "tools:free:holder_intelligence:v", window: 86_400, limit: 500 });
    expect(freeTestBucket("token_risk_analyst", "v").bucket).not.toBe(freeTestBucket("holder_intelligence", "v").bucket);
    expect(bucketsFor("v").map((b) => b.limit)).toEqual([6, 40, 60]);
  });
  it("intelligence tools are runnable and launchable", () => {
    const by = Object.fromEntries(LIBRARY.map((t) => [t.id, t]));
    expect([
      by["holder-intelligence"]!.tokenLaunch,
      by["token-risk-analyst"]!.tokenLaunch,
      by["smart-money-tracker"]!.tokenLaunch,
      by["onchain-report-builder"]!.tokenLaunch,
    ]).toEqual([true, true, true, true]);
  });
});
