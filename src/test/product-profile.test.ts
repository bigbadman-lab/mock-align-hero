// Phase 03-D: public product profile contract. Fixtures exist only in this file.
import { describe, expect, it } from "vitest";
import { loadProfile, PRODUCT_ENDPOINT_BASE, type ProfileConfigRow, type ProfileCreationRow, type ProfileDeps } from "@/lib/product-profile";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const row = (id: string, slug: string): ProfileCreationRow => ({
  id, slug, template_id: "whale-watch", template_version: 1, display_name: `Fixture ${slug}`, ticker: "FIX", description: "",
  creator_wallet: "W", child_mint: "M", quote_mint: "Q", network: "solana-mainnet", verified_tx_signature: "S", verified_slot: 1, verified_at: "2026-01-01T00:00:00Z",
});
const cfg = (id: string, minLamports: string, lifecycle = "active"): ProfileConfigRow => ({
  creation_id: id, template_id: "whale-watch", template_version: "1.0.0", tool_config: { minLamports }, lifecycle_state: lifecycle,
});
function deps(creations: ProfileCreationRow[], configs: ProfileConfigRow[], fail = false): ProfileDeps & { configCalls: string[] } {
  const configCalls: string[] = [];
  return {
    configCalls,
    async getCreationBySlug(s) { if (fail) throw new Error("x"); return creations.find((c) => c.slug === s) ?? null; },
    async getConfig(id) { configCalls.push(id); return configs.find((c) => c.creation_id === id) ?? null; },
  };
}

describe("product profile", () => {
  it("D01: zero creations → not found, no endpoint", async () => {
    expect(await loadProfile(deps([], []), "anything")).toEqual({ status: "not_found" });
  });
  it("D02: invalid slugs fail closed before any read; config looked up by canonical id", async () => {
    const d = deps([row(A, "alpha")], [cfg(A, "100000000")]);
    for (const s of ["", "../x", "A B", "x".repeat(80), "-a"]) expect((await loadProfile(d, s)).status).toBe("not_found");
    expect(d.configCalls).toEqual([]);
    await loadProfile(d, "alpha");
    expect(d.configCalls).toEqual([A]);
  });
  it("D03/D04: two Whale Watch products expose distinct identity, endpoint and fixed threshold; never raw config", async () => {
    const d = deps([row(A, "alpha"), row(B, "beta")], [cfg(A, "100000000"), cfg(B, "10000000000")]);
    const a = await loadProfile(d, "alpha"), b = await loadProfile(d, "beta");
    if (a.status !== "ok" || b.status !== "ok") throw new Error("expected ok");
    expect(a.profile.endpoint).toBe(PRODUCT_ENDPOINT_BASE + A);
    expect(b.profile.endpoint).toBe(PRODUCT_ENDPOINT_BASE + B);
    expect(a.profile.tool?.name).toBe("whale_watch");
    expect(a.profile.tool?.adapterVersion).toBe("1.0.0");
    expect(a.profile.tool?.fixedSettings[0]).toContain("0.1 SOL");
    expect(b.profile.tool?.fixedSettings[0]).toContain("10 SOL");
    const json = JSON.stringify(a);
    expect(json).not.toContain("minLamports");
    expect(json).not.toContain("tool_config");
    expect(a.profile.tool?.inputSchema).toContain("address");
  });
  it("D05: endpoint uses the routed path, never the future alias", async () => {
    const r = await loadProfile(deps([row(A, "alpha")], [cfg(A, "100000000")]), "alpha");
    expect(r.status === "ok" && r.profile.endpoint).toBe(`https://mcpx.fun/api/public/mcp/products/${A}`);
    expect(JSON.stringify(r)).not.toContain("mcp.mcpx.fun");
  });
  it("D08: inactive, suspended, unconfigured and misconfigured products expose no endpoint", async () => {
    const cases: [ProfileConfigRow[], string][] = [
      [[cfg(A, "100000000", "inactive")], "inactive"],
      [[cfg(A, "100000000", "suspended")], "suspended"],
      [[], "not_configured"],
      [[cfg(A, "123")], "misconfigured"],
      [[{ ...cfg(A, "100000000"), template_id: "wallet-inspector" }], "misconfigured"],
      [[{ ...cfg(A, "100000000"), template_version: "9.9.9" }], "misconfigured"],
    ];
    for (const [configs, want] of cases) {
      const r = await loadProfile(deps([row(A, "alpha")], configs), "alpha");
      if (r.status !== "ok") throw new Error("expected ok");
      expect(r.profile.availability).toBe(want);
      expect(r.profile.endpoint).toBeNull();
    }
  });
  it("D14: store outage → unavailable, never not_found", async () => {
    expect(await loadProfile(deps([], [], true), "alpha")).toEqual({ status: "unavailable" });
  });
});
