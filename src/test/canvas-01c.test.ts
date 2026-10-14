// CANVAS-01 completion: draft storage on, AI step contract, dry-run AI gating. Fixtures only (no network).
import { describe, it, expect, afterEach } from "vitest";
import { validateCanvas } from "@/lib/canvas/validate";
import { runCanvas, type RunDeps } from "@/lib/canvas/run";
import { canvasStorageEnabled } from "@/lib/launch/drafts.server";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const base = { catalogVersion: 1, steps: [{ capabilityId: "intel.holders", version: 1 }, { capabilityId: "wallet.inspect", version: 1, from: { step: 0, output: "largest_owner" } }] };
const holders = { executionId: "e1", mint: MINT, distribution: { owners: [{ owner: OWNER }] } };
const wallet = { executionId: "e2", address: OWNER, tokenHoldings: [] };

function deps(extra: Partial<RunDeps> = {}): RunDeps {
  let n = 0;
  return { traceId: "t", now: () => 0, available: async () => true, take: async () => "ok",
    execute: async () => ({ ok: true, out: n++ === 0 ? holders : wallet }), ...extra };
}

describe("Canvas draft storage", () => {
  const prev = process.env["MCPX_CANVAS_DRAFTS"];
  afterEach(() => { if (prev === undefined) delete process.env["MCPX_CANVAS_DRAFTS"]; else process.env["MCPX_CANVAS_DRAFTS"] = prev; });
  it("is on by default now that the database change is applied; '0' is the emergency stop", () => {
    delete process.env["MCPX_CANVAS_DRAFTS"];
    expect(canvasStorageEnabled()).toBe(true);
    process.env["MCPX_CANVAS_DRAFTS"] = "0";
    expect(canvasStorageEnabled()).toBe(false);
  });
});

describe("AI step config", () => {
  it("accepts exactly { summarize: true } and keeps it on round-trip", () => {
    const c = validateCanvas({ ...base, ai: { summarize: true } });
    expect(c.ok && c.config.ai).toEqual({ summarize: true });
    expect(JSON.stringify(c.ok && c.config)).toBe(JSON.stringify({ ...base, ai: { summarize: true } }));
  });
  it("refuses prompts, URLs, models or anything else in the AI step", () => {
    for (const ai of [{ summarize: true, prompt: "x" }, { url: "https://evil" }, { summarize: "yes" }, true, [], { model: "gpt-4o" }])
      expect(validateCanvas({ ...base, ai }).ok).toBe(false);
  });
});

describe("AI step in dry runs", () => {
  it("draft dry run (no product) never calls AI and says why", async () => {
    const r = await runCanvas({ ...base, ai: { summarize: true } }, MINT, deps());
    expect(r.ok && r.ai).toMatchObject({ status: "not_run" });
    expect(r.ok && r.complete).toBe(false);
  });
  it("product dry run summarises only the real step results, once", async () => {
    const seen: unknown[] = [];
    const r = await runCanvas({ ...base, ai: { summarize: true } }, MINT, deps({ summarise: async (x) => { seen.push(x); return { status: "ok", text: "Summary.", model: "gpt-4o-mini" }; } }));
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen[0])).toContain(OWNER);
    expect(r.ok && r.ai).toEqual({ status: "ok", model: "gpt-4o-mini", text: "Summary." });
    expect(r.ok && r.complete).toBe(true);
  });
  it("a failed tool step skips AI; an AI refusal (limits/paused) is reported, never invented", async () => {
    let called = false;
    const r1 = await runCanvas({ ...base, ai: { summarize: true } }, MINT, deps({ execute: async () => ({ ok: false, error: "upstream" }), summarise: async () => { called = true; return { status: "ok", text: "x" }; } }));
    expect(called).toBe(false);
    expect(r1.ok && r1.ai?.status).toBe("not_run");
    const r2 = await runCanvas({ ...base, ai: { summarize: true } }, MINT, deps({ summarise: async () => ({ status: "daily_limit" }) }));
    expect(r2.ok && r2.ai).toEqual({ status: "failed", error: "daily_limit" });
  });
  it("without the AI step, results are unchanged", async () => {
    const r = await runCanvas(base, MINT, deps());
    expect(r.ok && "ai" in r).toBe(false);
  });
});
