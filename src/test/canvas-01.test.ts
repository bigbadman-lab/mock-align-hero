import { describe, expect, it } from "vitest";
import { CAPABILITIES, CANVAS_CATALOG_VERSION, pick } from "@/lib/canvas/catalog";
import { validateCanvas, compatibleSources } from "@/lib/canvas/validate";
import { LIBRARY, TEMPLATES } from "@/lib/templates";

const V = CANVAS_CATALOG_VERSION;
const ok = (steps: unknown[]) => validateCanvas({ catalogVersion: V, steps });

describe("CANVAS-01 catalog", () => {
  it("every capability maps to a real, non-planned library tool with a worker id", () => {
    for (const c of CAPABILITIES) {
      const t = LIBRARY.find((x) => x.id === c.templateId);
      expect(t && !t.planned && t.toolId === c.toolId).toBe(true);
    }
  });
  it("excludes the report builder (no recursive composition)", () => {
    expect(CAPABILITIES.some((c) => c.templateId === "onchain-report-builder")).toBe(false);
  });
  it("Canvas is the 11th library template, honestly planned and not launchable yet", () => {
    expect(LIBRARY).toHaveLength(11);
    const c = LIBRARY.find((t) => t.id === "canvas")!;
    expect([c.planned, c.toolId, c.route, c.mcpAdapter, c.tokenLaunch]).toEqual([true, null, null, false, false]);
    expect(TEMPLATES.some((t) => t.id === "canvas")).toBe(false);
  });
});

describe("CANVAS-01 validator", () => {
  it("accepts a token → holders → wallet pipeline", () => {
    const r = ok([{ capabilityId: "intel.holders", version: 1 }, { capabilityId: "wallet.inspect", version: 1, from: { step: 0, output: "largest_owner" } }]);
    expect(r.ok && r.entryKind).toBe("mint");
  });
  it("accepts a wallet output as an account to check", () => {
    expect(ok([{ capabilityId: "wallet.whale", version: 1 }, { capabilityId: "verify.account", version: 1, from: { step: 0, output: "latest_counterparty" } }]).ok).toBe(true);
  });
  it("rejects incompatible kinds with a clear message", () => {
    const r = ok([{ capabilityId: "wallet.whale", version: 1 }, { capabilityId: "token.supply", version: 1, from: { step: 0, output: "latest_counterparty" } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Supply Monitor needs a token mint/);
  });
  it("rejects one step, more than four steps and repeats", () => {
    expect(ok([{ capabilityId: "token.scan", version: 1 }]).ok).toBe(false);
    expect(ok(Array(5).fill({ capabilityId: "token.scan", version: 1 })).ok).toBe(false);
    expect(ok([{ capabilityId: "token.supply", version: 1 }, { capabilityId: "token.supply", version: 1, from: { step: 0, output: "largest_token_account" } }]).ok).toBe(false);
  });
  it("rejects forward/self references (no cycles)", () => {
    expect(ok([{ capabilityId: "token.supply", version: 1 }, { capabilityId: "verify.account", version: 1, from: { step: 1, output: "largest_token_account" } }]).ok).toBe(false);
  });
  it("rejects forged capabilities, versions, extra fields and URLs", () => {
    expect(ok([{ capabilityId: "http.fetch", version: 1 }, { capabilityId: "token.scan", version: 1 }]).ok).toBe(false);
    expect(ok([{ capabilityId: "token.scan", version: 2 }, { capabilityId: "token.supply", version: 1 }]).ok).toBe(false);
    expect(ok([{ capabilityId: "token.supply", version: 1, url: "https://x.io" }, { capabilityId: "token.scan", version: 1 }]).ok).toBe(false);
    expect(validateCanvas({ catalogVersion: V, steps: [], script: "x" }).ok).toBe(false);
    expect(validateCanvas({ catalogVersion: 99, steps: [] }).ok).toBe(false);
  });
  it("step 1 can't read from another step; later steps must", () => {
    expect(ok([{ capabilityId: "token.scan", version: 1, from: { step: 0, output: "x" } }, { capabilityId: "token.supply", version: 1 }]).ok).toBe(false);
    expect(ok([{ capabilityId: "token.scan", version: 1 }, { capabilityId: "token.supply", version: 1 }]).ok).toBe(false);
  });
  it("compatibleSources lists only matching outputs", () => {
    const s = [{ capabilityId: "token.supply", version: 1 }, { capabilityId: "verify.account", version: 1 }];
    expect(compatibleSources(s, 1).map((x) => x.output)).toEqual(["largest_token_account"]);
  });
  it("pick reads only fixed paths and only address-shaped strings", () => {
    const addr = "So11111111111111111111111111111111111111112";
    expect(pick({ distribution: { owners: [{ owner: addr }] } }, "distribution.owners[0].owner")).toBe(addr);
    expect(pick({ distribution: { owners: [{ owner: "<script>" }] } }, "distribution.owners[0].owner")).toBeNull();
    expect(pick({ tokenHoldings: [] }, "tokenHoldings[0].mint")).toBeNull();
  });
});
