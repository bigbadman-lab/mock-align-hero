import { describe, it, expect } from "vitest";
import { LIBRARY, TEMPLATES } from "@/lib/templates";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";

describe("tool library registry", () => {
  it("lists exactly ten templates with unique ids", () => {
    expect(LIBRARY).toHaveLength(20);
    expect(new Set(LIBRARY.map((t) => t.id)).size).toBe(20);
  });
  it("keeps deployed ids and maps them explicitly to relay ids and routes", () => {
    const m = Object.fromEntries(LIBRARY.filter((t) => !t.planned).map((t) => [t.id, [t.toolId, t.route]]));
    expect(m).toEqual({
      "wallet-inspector": ["wallet_inspector", "/tools/wallet-inspector"],
      "whale-watch": ["whale_watch", "/tools/whale-watch"],
      "token-scanner": ["token_scanner", "/tools/token-scanner"],
      "supply-monitor": ["supply_monitor", "/tools/supply-monitor"],
      "tx-verifier": ["transaction_verifier", "/tools/transaction-verifier"],
      "account-checker": ["account_checker", "/tools/account-checker"],
      "holder-intelligence": ["holder_intelligence", "/tools/holder-intelligence"],
      "token-risk-analyst": ["token_risk_analyst", "/tools/token-risk-analyst"],
      canvas: [null, null],
      "smart-money-tracker": ["smart_money_tracker", "/tools/smart-money-tracker"],
      "onchain-report-builder": ["onchain_report_builder", "/tools/onchain-report-builder"],
      "gibberish-ai": ["gibberish_ai", "/tools/ai/gibberish-ai"],
      "roast-bot": ["roast_bot", "/tools/ai/roast-bot"],
      "excuse-machine": ["excuse_machine", "/tools/ai/excuse-machine"],
      "conspiracy-potato": ["conspiracy_potato", "/tools/ai/conspiracy-potato"],
      "argument-machine": ["argument_machine", "/tools/ai/argument-machine"],
      "future-you": ["future_you", "/tools/ai/future-you"],
      "web3-startup-roulette": ["web3_startup_roulette", "/tools/ai/web3-startup-roulette"],
      "monster-factory": ["monster_factory", "/tools/ai/monster-factory"],
      "pigeon-ceo": ["pigeon_ceo", "/tools/ai/pigeon-ceo"],
    });
  });
  it("planned templates have no tool, route, MCP or launch", () => {
    for (const t of LIBRARY.filter((x) => x.planned)) expect([t.toolId, t.route, t.mcpAdapter, t.tokenLaunch]).toEqual([null, null, false, false]);
    expect(LIBRARY.filter((x) => x.planned).map((t) => t.id)).toEqual([]);
  });
  it("MCP flag matches real gateway adapters", () => {
    expect(LIBRARY.filter((t) => t.mcpAdapter).map((t) => t.id).sort()).toEqual(Object.keys(ADAPTERS).sort());
  });
  it("launch flag matches the launch form's templates", () => {
    expect(LIBRARY.filter((t) => t.tokenLaunch).map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
  });
});

describe("template detail pages", () => {
  it("every library template id is a valid detail slug", () => {
    for (const t of LIBRARY) expect(t.id).toMatch(/^[a-z0-9-]+$/);
  });
});

import { FREE_TESTS_PER_DAY, freeTestBucket, bucketsFor } from "@/lib/tools/relay";
describe("free tests", () => {
  it("allows 100 free website tests per visitor, per tool, per day", () => {
    expect(FREE_TESTS_PER_DAY).toBe(100);
    const a = freeTestBucket("whale_watch", "v1");
    expect([a.limit, a.window]).toEqual([100, 86_400]);
    expect(a.bucket).not.toBe(freeTestBucket("token_scanner", "v1").bucket);
    expect(a.bucket).not.toBe(freeTestBucket("whale_watch", "v2").bucket);
  });
  it("is separate from the shared rate-limit buckets", () => {
    expect(bucketsFor("v1").map((b) => b.bucket)).not.toContain(freeTestBucket("whale_watch", "v1").bucket);
  });
});

import { resolveTemplateParam } from "@/lib/templates";
describe("launch deep links", () => {
  it("no or empty param means no preselection", () => {
    expect(resolveTemplateParam(undefined)).toEqual({ kind: "none" });
    expect(resolveTemplateParam("  ")).toEqual({ kind: "none" });
    expect(resolveTemplateParam(42)).toEqual({ kind: "none" });
  });
  it("canonical ids preselect", () => {
    expect(resolveTemplateParam("whale-watch")).toEqual({ kind: "launchable", id: "whale-watch" });
  });
  it("legacy transaction verifier spellings map to tx-verifier", () => {
    for (const v of ["tx-verifier", "transaction-verifier", "transaction_verifier", "TX_VERIFIER"]) expect(resolveTemplateParam(v)).toEqual({ kind: "launchable", id: "tx-verifier" });
  });
  it("relay ids map to canonical ids", () => {
    expect(resolveTemplateParam("wallet_inspector")).toEqual({ kind: "launchable", id: "wallet-inspector" });
  });
  it("intelligence templates are launchable", () => {
    expect(resolveTemplateParam("holder-intelligence").kind).toBe("launchable");
  });
  it("unknown values are reported, not guessed", () => {
    expect(resolveTemplateParam("../etc").kind).toBe("unknown");
  });
});
