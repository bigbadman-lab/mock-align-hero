import { describe, it, expect } from "vitest";
import { ADAPTERS, PLATFORM_DEMO, adaptersFor } from "@/lib/mcp-gateway/registry";
import { tokenMatches } from "@/lib/mcp-gateway/server";

describe("mcp gateway", () => {
  it("platform demo exposes exactly the wallet inspector tool", () => {
    expect(adaptersFor(PLATFORM_DEMO).map((a) => a.toolName)).toEqual(["wallet_inspector"]);
  });
  it("version mismatch is skipped, not guessed", () => {
    expect(adaptersFor({ id: "x", kind: "platform-demo", templates: [{ templateId: "wallet-inspector", version: "9.9.9" }] })).toEqual([]);
  });
  it("adding a template is registration only", () => {
    ADAPTERS["future"] = { ...ADAPTERS["wallet-inspector"]!, templateId: "future", toolName: "future_tool" };
    const p = { id: "t", kind: "platform-demo" as const, templates: [{ templateId: "wallet-inspector", version: "1.0.0" }, { templateId: "future", version: "1.0.0" }] };
    expect(adaptersFor(p).map((a) => a.toolName)).toEqual(["wallet_inspector", "future_tool"]);
    delete ADAPTERS["future"];
  });
  it("input schema rejects bad address and extra keys", () => {
    const s = ADAPTERS["wallet-inspector"]!.inputSchema;
    expect(s.safeParse({ address: "bad" }).success).toBe(false);
    expect(s.safeParse({ address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", x: 1 }).success).toBe(false);
    expect(s.safeParse({ address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }).success).toBe(true);
  });
  it("token comparison", async () => {
    expect(await tokenMatches("a".repeat(40), "a".repeat(40))).toBe(true);
    expect(await tokenMatches("b".repeat(40), "a".repeat(40))).toBe(false);
  });
});
