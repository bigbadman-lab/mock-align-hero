import { describe, it, expect } from "vitest";
import { validateDraft, checkLink, FEE_SPLIT, type DraftInput } from "@/lib/launch/draft";
import { serverReadiness } from "@/lib/launch/readiness";
import { interpretReady } from "@/lib/tx-builder/contract";
import { TEMPLATES } from "@/lib/templates";

const ok: DraftInput = { templateId: "whale-watch", settings: { minLamports: "1000000000" }, productName: "Big Fish", tokenName: "Big Fish", symbol: "FISH", description: "Watches whales.", link: "", buyEnabled: false, buyAmount: "", slippageBps: "100" };
const errs = (p: Partial<DraftInput>) => { const r = validateDraft({ ...ok, ...p }); return r.ok ? {} : r.errors; };

describe("launch draft (04-C)", () => {
  it("accepts a valid draft with no buy", () => expect(validateDraft(ok).ok).toBe(true));
  it("every catalogue template is selectable", () => {
    for (const t of TEMPLATES) expect(validateDraft({ ...ok, templateId: t.id, settings: t.id === "whale-watch" ? ok.settings : {} }).ok).toBe(true);
  });
  it("rejects unknown template and unsupported settings", () => {
    expect(errs({ templateId: "nope" }).templateId).toBeTruthy();
    expect(errs({ settings: { minLamports: "5" } }).settings).toBeTruthy();
    expect(errs({ settings: { minLamports: "1000000000", rpc: "x" } }).settings).toBeTruthy();
    expect(errs({ templateId: "token-scanner", settings: { a: "b" } }).settings).toBeTruthy();
  });
  it("token name capped at 32 UTF-8 bytes", () => {
    expect(errs({ tokenName: "a".repeat(32) }).tokenName).toBeUndefined();
    expect(errs({ tokenName: "é".repeat(17) }).tokenName).toBeTruthy(); // 34 bytes
    expect(errs({ tokenName: " x" }).tokenName).toBeTruthy();
    expect(errs({ tokenName: "a\u202eb" }).tokenName).toBeTruthy();
  });
  it("symbol 1–10 alphanumerics", () => {
    expect(errs({ symbol: "ABCDEFGHIJ" }).symbol).toBeUndefined();
    for (const s of ["", "ABCDEFGHIJK", "AB C", "$MCP"]) expect(errs({ symbol: s }).symbol).toBeTruthy();
  });
  it("description capped at 500 bytes", () => expect(errs({ description: "x".repeat(501) }).description).toBeTruthy());
  it("links: https public domains only", () => {
    expect(checkLink("https://x.com/mcpdotfun")).toBe("https://x.com/mcpdotfun");
    for (const l of ["http://a.com", "javascript:alert(1)", "https://127.0.0.1", "https://localhost", "https://u:p@a.com", "https://a.com:8443", "https://[::1]", "https://a.internal", "https://a.com/" + "x".repeat(200)])
      expect(typeof checkLink(l)).toBe("object");
  });
  it("initial buy bounds: positive, ≤9 decimals, slippage 1–1000 bps", () => {
    const b = { buyEnabled: true };
    expect(errs({ ...b, buyAmount: "1.5", slippageBps: "100" })).toEqual({});
    expect(errs({ ...b, buyAmount: "0", slippageBps: "100" }).buyAmount).toBeTruthy();
    expect(errs({ ...b, buyAmount: "1.0000000001", slippageBps: "100" }).buyAmount).toBeTruthy();
    expect(errs({ ...b, buyAmount: "1", slippageBps: "1001" }).slippageBps).toBeTruthy();
  });
  it("fee split is exactly 6000/2500/1500", () => expect(FEE_SPLIT.map((f) => f.bps)).toEqual([6000, 2500, 1500]));
});

describe("launch readiness (04-C)", () => {
  it("parent, lookup table, simulation and signing stay BLOCKED even with a ready builder", () => {
    const items = serverReadiness(interpretReady({ ready: true, quoteMint: "CONFIGURED" }));
    const by = Object.fromEntries(items.map((i) => [i.id, i.state]));
    expect(by).toMatchObject({ parent: "BLOCKED", alt: "BLOCKED", simulation: "BLOCKED", signing: "BLOCKED", builder: "READY", storage: "NOT_CONFIGURED" });
  });
  it("not deployed, timeout and malformed are distinct and never READY", () => {
    expect(serverReadiness({ state: "BUILDER_NOT_DEPLOYED" }).find((i) => i.id === "builder")?.state).toBe("NOT_CONFIGURED");
    expect(serverReadiness({ state: "BUILDER_TIMEOUT" }).find((i) => i.id === "builder")?.detail).toMatch(/in time/);
    expect(interpretReady([1])).toEqual({ state: "BUILDER_MALFORMED" });
    expect(interpretReady({ ready: "yes" })).toEqual({ state: "BUILDER_MALFORMED" });
  });
});

describe("builder bridge states (04-D)", () => {
  it("an error HTTP status is UNHEALTHY, distinct from unreachable", async () => {
    const { getBuilderStatus } = await import("@/lib/tx-builder/status.server");
    const prev = process.env["MCPX_TX_BUILDER_URL"];
    process.env["MCPX_TX_BUILDER_URL"] = "https://builder.example";
    const f = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    expect(await getBuilderStatus(f)).toEqual({ state: "BUILDER_UNHEALTHY" });
    process.env["MCPX_TX_BUILDER_URL"] = prev ?? "";
  });
});
