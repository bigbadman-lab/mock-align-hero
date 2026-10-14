// Canvas (Template 11) products on the existing product MCP endpoint. One tool, `run_canvas`, whose pipeline is
// the product's latest immutable Canvas version (server-side; callers can't change steps). Each step goes through
// the same shared rate buckets and signed worker call as every other tool; AI summary only when the creator's
// own key is active. Kept out of ADAPTERS so the ten single-tool adapters are untouched.
import * as z from "zod/v4";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { CAPABILITY_BY_ID } from "@/lib/canvas/catalog";
import { validValue } from "@/lib/canvas/adapters";
import { validateCanvas, type CanvasConfig } from "@/lib/canvas/validate";
import { runCanvas } from "@/lib/canvas/run";
import type { TemplateAdapter } from "./registry";

export const CANVAS_TOOL = "run_canvas";
export type CanvasVersion = { version: number; config: unknown };

/** Marker adapter so authorizeProduct/ResolvedProduct stay unchanged. Never executed directly. */
export function canvasMarker(cfg: CanvasConfig, version: number): TemplateAdapter {
  return {
    templateId: "canvas", version: `1.0.${version}`, toolName: CANVAS_TOOL, workerToolId: CAPABILITY_BY_ID[cfg.steps[0]!.capabilityId]!.toolId,
    title: "Canvas pipeline (Solana mainnet, read-only)", description: describeCanvas(cfg),
    inputSchema: z.strictObject({}), parseSettings: () => ({}), describeSettings: () => [], defaultSettings: {},
    toWorkerPayload: () => { throw new Error("canvas_marker"); }, validOutput: () => false,
  };
}

export function describeCanvas(cfg: CanvasConfig): string {
  const names = cfg.steps.map((s) => CAPABILITY_BY_ID[s.capabilityId]!.name);
  return `Runs ${names.length} read-only MCPX tools in a fixed order: ${names.join(" → ")}. Each step receives one approved value from an earlier step. `
    + "Stops at the first step that can't complete and reports it — later steps are marked not run, never invented. Shared rate limits apply per step.";
}

export function canvasInputSchema(cfg: CanvasConfig, ai: boolean) {
  const entry = CAPABILITY_BY_ID[cfg.steps[0]!.capabilityId]!.input;
  const base = { input: z.string().min(32).max(88).refine((v) => validValue(entry.kind, v), `Must be a valid ${entry.label.toLowerCase()}`).describe(`${entry.label} for step 1.`) };
  return (ai && cfg.ai ? z.strictObject({ ...base, ai_summary: z.boolean().optional().describe("Also return a short AI summary (creator's OpenAI key; counted against the product's AI limits).") }) : z.strictObject(base)) as unknown as StandardSchemaWithJSON;
}

export type CanvasExec = {
  available: (toolId: string) => Promise<boolean>;
  take: () => Promise<"ok" | "limited" | "unavailable">;
  execute: (payload: string) => Promise<{ ok: true; out: unknown } | { ok: false; error: string }>;
  summarise?: (r: unknown) => Promise<{ status: string; text?: string; model?: string }>;
};

export async function executeCanvasTool(cfg: CanvasConfig, version: number, raw: unknown, x: CanvasExec) {
  const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_input");
  const r = raw as { input?: unknown; ai_summary?: unknown };
  if (Object.keys(r).some((k) => k !== "input" && k !== "ai_summary")) return fail("invalid_input");
  const wantAi = r.ai_summary === true && !!cfg.ai && !!x.summarise;
  const runCfg = wantAi ? cfg : { catalogVersion: cfg.catalogVersion, steps: cfg.steps };
  const out = await runCanvas(runCfg, typeof r.input === "string" ? r.input : null, {
    traceId: crypto.randomUUID(), now: Date.now, available: x.available, take: x.take, execute: x.execute,
    ...(wantAi && x.summarise ? { summarise: x.summarise } : {}),
  });
  if (!out.ok) return fail(out.error);
  const lim = out.steps.find((s) => s.status === "failed" && (s.error === "rate_limited" || s.error === "unavailable"));
  const body = { canvasVersion: version, traceId: out.traceId, complete: out.complete, steps: out.steps, ...(out.ai ? { aiSummary: out.ai } : {}) };
  const json = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  return { ...(lim ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: json,
    _meta: { "mcpx/templateId": "canvas", "mcpx/canvasVersion": version } };
}

export const parseCanvasVersion = (v: CanvasVersion | null): { cfg: CanvasConfig; version: number } | null => {
  if (!v) return null;
  const c = validateCanvas(v.config);
  return c.ok ? { cfg: c.config, version: v.version } : null;
};
