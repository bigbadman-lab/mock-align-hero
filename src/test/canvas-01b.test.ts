import { describe, expect, it } from "vitest";
import { CAPABILITIES, CANVAS_CATALOG_VERSION } from "@/lib/canvas/catalog";
import { CANVAS_ADAPTERS } from "@/lib/canvas/adapters";
import { runCanvas, type RunDeps } from "@/lib/canvas/run";
import { validateDraft, type DraftInput } from "@/lib/launch/draft";
import { parseDraftBody, toInput } from "@/lib/launch/drafts-core";

const MINT = "So11111111111111111111111111111111111111112";
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const pipe = { catalogVersion: CANVAS_CATALOG_VERSION, steps: [{ capabilityId: "intel.holders", version: 1 }, { capabilityId: "wallet.inspect", version: 1, from: { step: 0, output: "largest_owner" } }] };
const base: DraftInput = { templateId: "canvas", settings: {}, productName: "Pipe", toolDescription: "", tokenName: "Pipe", symbol: "PIPE", description: "d", link: "", buyEnabled: false, buyAmount: "", slippageBps: "100", canvas: pipe };

describe("CANVAS-01 adapters", () => {
  it("every catalog capability has exactly one worker adapter, and nothing else does", () => {
    expect(Object.keys(CANVAS_ADAPTERS).sort()).toEqual(CAPABILITIES.map((c) => c.id).sort());
  });
});

describe("CANVAS-01 draft integration", () => {
  it("Canvas drafts require a valid pipeline", () => {
    expect(validateDraft(base).ok).toBe(true);
    const bad = validateDraft({ ...base, canvas: { catalogVersion: 1, steps: [pipe.steps[0]!] } });
    expect(!bad.ok && bad.errors.canvas).toMatch(/at least 2/);
    expect(validateDraft({ ...base, canvas: null }).ok).toBe(false);
  });
  it("other templates can't carry a pipeline", () => {
    expect(validateDraft({ ...base, templateId: "token-scanner" }).ok).toBe(false);
    const { canvas: _c, ...plain } = base;
    expect(validateDraft({ ...plain, templateId: "token-scanner" }).ok).toBe(true);
  });
  it("a saved Canvas draft restores the exact same pipeline", () => {
    const p = parseDraftBody({ action: "create", createKey: "k".repeat(20), draft: base });
    if (!("action" in p) || p.action !== "create") throw new Error("parse");
    expect(toInput(p.draft).canvas).toEqual(pipe);
    expect(validateDraft(toInput(p.draft)).ok).toBe(true);
  });
  it("forged pipelines are refused at the request boundary", () => {
    const p = parseDraftBody({ action: "create", createKey: "k".repeat(20), draft: { ...base, canvas: { catalogVersion: 1, steps: [{ capabilityId: "http.fetch", version: 1 }, pipe.steps[1]] } } });
    expect("error" in p && p.error).toBe("invalid_draft");
  });
});

const hi = { schema: "x", executionId: "e1", distribution: { owners: [{ owner: OWNER }] } };
const deps = (over: Partial<RunDeps> = {}): RunDeps & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, traceId: "t", now: () => 0, available: async () => true, take: async () => "ok",
    execute: async (p) => { calls.push(p); return { ok: true, out: JSON.parse(p).toolId === "holder_intelligence" ? hi : { executionId: "e2" } }; }, ...over };
};

describe("CANVAS-01 dry-run engine", () => {
  // Swap real result validators for structural stubs in this unit test only.
  CANVAS_ADAPTERS["intel.holders"]!.check = () => true;
  CANVAS_ADAPTERS["wallet.inspect"]!.check = () => true;
  it("passes only the mapped value to the next step", async () => {
    const d = deps();
    const r = await runCanvas(pipe, MINT, d);
    expect(r.ok && r.complete).toBe(true);
    expect(JSON.parse(d.calls[1]!).input).toEqual({ address: OWNER });
    expect(d.calls).toHaveLength(2);
  });
  it("stops (never fabricates) when a step yields no mapped value", async () => {
    const d = deps({ execute: async () => ({ ok: true, out: { executionId: "e", distribution: { owners: [] } } }) });
    const r = await runCanvas(pipe, MINT, d);
    expect(r.ok && r.complete).toBe(false);
    expect(r.ok && r.steps[1]!.status).toBe("failed");
  });
  it("stops when a tool isn't deployed or rate limits apply", async () => {
    const a = await runCanvas(pipe, MINT, deps({ available: async () => false }));
    expect(a.ok && a.steps.map((s) => s.status)).toEqual(["failed", "not_run"]);
    const b = await runCanvas(pipe, MINT, deps({ take: async () => "limited" }));
    expect(b.ok && b.steps[0]!.status === "failed" && b.steps[0]!.error).toBe("rate_limited");
  });
  it("takes the shared budget once per executed step", async () => {
    let n = 0;
    await runCanvas(pipe, MINT, deps({ take: async () => { n++; return "ok"; } }));
    expect(n).toBe(2);
  });
  it("refuses invalid configs and inputs before any worker call", async () => {
    const d = deps();
    expect((await runCanvas({ ...pipe, steps: [] }, MINT, d)).ok).toBe(false);
    expect((await runCanvas(pipe, "not-an-address", d)).ok).toBe(false);
    expect(d.calls).toHaveLength(0);
  });
});
