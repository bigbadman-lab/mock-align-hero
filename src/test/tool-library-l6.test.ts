// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { trackWallets, validInput as smtValid, MAX_CALLS } from "../../services/mcp-worker/src/tracker.mjs";
// @ts-expect-error plain JS worker module
import { buildReport, validInput as orbValid, CALL_BUDGET } from "../../services/mcp-worker/src/report.mjs";
import { isSmartMoneyResult, parseWallets } from "@/lib/tools/smart-money-tracker";
import { isOnchainReport } from "@/lib/tools/onchain-report";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
import { freeTestBucket } from "@/lib/tools/relay";

const SYS = "11111111111111111111111111111111";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const W1 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const W2 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const W3 = "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy";
const W4 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const res = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
const sig = (n: number, err: unknown = null, blockTime: number | null = 1_700_000_000) => ({ signature: "s".repeat(60) + n, slot: 100 - n, err, blockTime });
const tx = (from: string, to: string, lamports: number) => ({ slot: 99, blockTime: 1, meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ programId: SYS, parsed: { type: "transfer", info: { source: from, destination: to, lamports } } }] } } });

function smt(wallets: string[], h: { sigs?: (w: string) => Response; tx?: () => Response } = {}) {
  let calls = 0;
  const fetchImpl = async (_u: string, init: RequestInit) => {
    calls++;
    const b = JSON.parse(String(init.body));
    if (b.method === "getSignaturesForAddress") return (h.sigs ?? (() => res(Array.from({ length: 20 }, (_, i) => sig(i)))))(b.params[0]);
    return (h.tx ?? (() => res(tx(wallets[0]!, W4, 2_000_000_000))))();
  };
  return trackWallets({ wallets, rpcUrl: "https://x", executionId: "x", fetchImpl }).then((o: any) => ({ o, calls }));
}

describe("Smart Money Tracker", () => {
  it("validates wallets: 1–3, unique, canonical, exact keys", () => {
    expect(smtValid({ wallets: [W1] })).toBe(true);
    expect(smtValid({ wallets: [] })).toBe(false);
    expect(smtValid({ wallets: [W1, W1] })).toBe(false);
    expect(smtValid({ wallets: [W1, W2, W3, W4] })).toBe(false);
    expect(smtValid({ wallets: ["nope"] })).toBe(false);
    expect(smtValid({ wallets: [W1], limit: 50 })).toBe(false);
    expect(parseWallets([W1, W1])).toBeNull();
  });
  it("bounded: 3 wallets never exceed 18 calls; 5 decoded per wallet, rest not inspected", async () => {
    const { o, calls } = await smt([W1, W2, W3]);
    expect(calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(MAX_CALLS).toBe(18);
    expect(o.wallets[0].counts).toMatchObject({ signaturesSeen: 20, decoded: 5, notInspected: 15 });
    expect(o.wallets[0].highlights.length).toBe(5); // 2 SOL ≥ 1 SOL threshold
    expect(isSmartMoneyResult(o, [W1, W2, W3])).toBe(true);
  });
  it("failed transactions are not fetched; missing timestamps stay null", async () => {
    const { o, calls } = await smt([W1], { sigs: () => res([sig(0, { x: 1 }, null)]) });
    expect(calls).toBe(1);
    expect(o.wallets[0].signatures[0]).toMatchObject({ succeeded: false, detail: "failed_tx", blockTime: null });
    expect(o.wallets[0].counts.missingBlockTime).toBe(1);
  });
  it("empty history and provider error per wallet are honest; sample marked incomplete", async () => {
    const { o } = await smt([W1, W2], { sigs: (w) => (w === W1 ? res([]) : new Response("x", { status: 429 })) });
    expect(o.wallets[0]).toMatchObject({ status: "ok", signatures: [] });
    expect(o.wallets[1]).toMatchObject({ status: "unavailable", reason: "rate_limited" });
    expect(o.complete).toBe(false);
  });
  it("unreadable transaction is reported, not counted as no activity", async () => {
    const { o } = await smt([W1], { tx: () => res(null) });
    expect(o.wallets[0].counts.unavailable).toBe(5);
    expect(o.complete).toBe(false);
  });
});

const mintAcct = { context: { slot: 5 }, value: { owner: SPL, data: { parsed: { type: "mint", info: { isInitialized: true, decimals: 2, supply: "1000", mintAuthority: null, freezeAuthority: null } } } } };
function orb(targetType: string, fail: Record<string, boolean> = {}) {
  let calls = 0;
  const fetchImpl = async (_u: string, init: RequestInit) => {
    calls++;
    const b = JSON.parse(String(init.body));
    if (fail[b.method]) return new Response("x", { status: 500 });
    switch (b.method) {
      case "getBalance": return res({ context: { slot: 5 }, value: 1_000_000_000 });
      case "getTokenAccountsByOwner": return res({ context: { slot: 5 }, value: [] });
      case "getAccountInfo": return b.params[1].encoding === "jsonParsed" ? res(mintAcct) : res({ context: { slot: 5 }, value: { owner: SYS, executable: false, lamports: 1, space: 0, data: ["", "base64"] } });
      case "getTokenSupply": return res({ context: { slot: 5 }, value: { amount: "1000", decimals: 2 } });
      case "getTokenLargestAccounts": return res({ context: { slot: 5 }, value: [{ address: W1, amount: "600", decimals: 2 }] });
    }
    return new Response("x", { status: 400 });
  };
  return buildReport({ targetType, target: W1, rpcUrl: "https://x", executionId: "x", fetchImpl }).then((o: any) => ({ o, calls }));
}

describe("Onchain Report Builder", () => {
  it("validates target: exact keys, wallet|token, canonical address", () => {
    expect(orbValid({ targetType: "wallet", target: W1 })).toBe(true);
    expect(orbValid({ targetType: "nft", target: W1 })).toBe(false);
    expect(orbValid({ targetType: "token", target: "bad" })).toBe(false);
    expect(orbValid({ targetType: "token", target: W1, extra: 1 })).toBe(false);
  });
  it("wallet report: 2 components, ≤ budget calls, complete, evidence kept", async () => {
    const { o, calls } = await orb("wallet");
    expect(o.components.map((c: any) => c.tool)).toEqual(["wallet_inspector", "account_checker"]);
    expect(calls).toBeLessThanOrEqual(CALL_BUDGET);
    expect(o.status).toBe("complete");
    expect(o.findings.find((f: any) => f.id === "sol_balance")).toMatchObject({ text: "SOL balance: 1 SOL.", evidence: "getBalance @ slot 5" });
    expect(isOnchainReport(o, "wallet", W1)).toBe(true);
  });
  it("token report: largest accounts described as accounts, not holders; no 'safe' wording", async () => {
    const { o } = await orb("token");
    const text = o.findings.map((f: any) => f.text).join(" ");
    expect(text).toContain("token accounts, not holders");
    expect(text.toLowerCase()).not.toMatch(/\b(safe|scam|rug|smart)\b/);
    expect(isOnchainReport(o, "token", W1)).toBe(true);
  });
  it("optional component failure → PARTIAL, conspicuously labelled, unknown not invented", async () => {
    const { o } = await orb("token", { getTokenLargestAccounts: true });
    expect(o.status).toBe("partial");
    expect(o.limitations.some((l: string) => l.startsWith("PARTIAL"))).toBe(true);
    expect(o.findings.find((f: any) => f.id === "largest_accounts").text).toContain("unknown");
    o.status = "complete";
    expect(isOnchainReport(o, "token", W1)).toBe(false);
  });
  it("required component failure fails closed", async () => {
    await expect(orb("token", { getAccountInfo: true })).rejects.toMatchObject({ kind: "provider_error" });
  });
});

describe("L6 integration", () => {
  it("MCP adapters with strict input", () => {
    expect(ADAPTERS["smart-money-tracker"]!.inputSchema.safeParse({ wallets: [W1, W2] }).success).toBe(true);
    expect(ADAPTERS["smart-money-tracker"]!.inputSchema.safeParse({ wallets: [W1, W1] }).success).toBe(false);
    expect(ADAPTERS["smart-money-tracker"]!.inputSchema.safeParse({ wallets: [W1, W2, W3, W4] }).success).toBe(false);
    expect(ADAPTERS["onchain-report-builder"]!.inputSchema.safeParse({ targetType: "token", target: W1 }).success).toBe(true);
    expect(ADAPTERS["onchain-report-builder"]!.inputSchema.safeParse({ targetType: "x", target: W1 }).success).toBe(false);
  });
  it("one report = one free test bucket (its own tool id), 3 per day", () => {
    expect(freeTestBucket("onchain_report_builder", "v")).toEqual({ bucket: "tools:free:onchain_report_builder:v", window: 86_400, limit: 3 });
  });
});
