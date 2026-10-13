import { describe, it, expect } from "vitest";
import { LIBRARY, TEMPLATES } from "@/lib/templates";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";

describe("tool library registry", () => {
  it("lists exactly ten templates with unique ids", () => {
    expect(LIBRARY).toHaveLength(10);
    expect(new Set(LIBRARY.map((t) => t.id)).size).toBe(10);
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
    });
  });
  it("planned templates have no tool, route, MCP or launch", () => {
    for (const t of LIBRARY.filter((x) => x.planned)) expect([t.toolId, t.route, t.mcpAdapter, t.tokenLaunch]).toEqual([null, null, false, false]);
    expect(LIBRARY.filter((x) => x.planned).map((t) => t.id)).toEqual(["holder-intelligence", "token-risk-analyst", "smart-money-tracker", "onchain-report-builder"]);
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
