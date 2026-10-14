// Canvas dry-run engine. Pure orchestration with injected I/O so it is testable without the network.
// Re-validates the config, runs steps strictly in order through the existing signed worker call,
// passes forward only the single catalog-mapped value, and stops at the first failure (never fabricates).
import { CAPABILITY_BY_ID, pick } from "./catalog";
import { CANVAS_ADAPTERS, validValue } from "./adapters";
import { validateCanvas } from "./validate";

export const DRY_RUN_TOTAL_MS = 90_000;
export const STEP_OUTPUT_MAX_BYTES = 400_000;

export interface RunDeps {
  available: (toolId: string) => Promise<boolean>;
  /** Shared visitor+global budget; called once per executed step. */
  take: () => Promise<"ok" | "limited" | "free_limit" | "unavailable">;
  execute: (payload: string) => Promise<{ ok: true; out: unknown } | { ok: false; error: string }>;
  now: () => number;
  traceId: string;
  /** Final AI step (product context only): creator-owned key via src/lib/byok/execute.ts. Absent = draft dry run. */
  summarise?: (results: unknown) => Promise<{ status: string; text?: string; model?: string }>;
}

export type StepTrace =
  | { step: number; capabilityId: string; status: "ok"; input: string; executionId: string | null; passed: string | null; result: unknown }
  | { step: number; capabilityId: string; status: "failed"; input: string | null; error: string }
  | { step: number; capabilityId: string; status: "not_run"; reason: string };

export type DryRun =
  | { ok: false; error: "invalid_canvas"; errors: string[] }
  | { ok: false; error: "invalid_input" }
  | { ok: true; dryRun: true; traceId: string; complete: boolean; steps: StepTrace[]; ai?: AiTrace };

export type AiTrace =
  | { status: "ok"; model: string; text: string }
  | { status: "not_run"; reason: string }
  | { status: "failed"; error: string };

export async function runCanvas(rawConfig: unknown, entryValue: unknown, d: RunDeps): Promise<DryRun> {
  const v = validateCanvas(rawConfig);
  if (!v.ok) return { ok: false, error: "invalid_canvas", errors: v.errors };
  if (typeof entryValue !== "string" || !validValue(v.entryKind, entryValue.trim())) return { ok: false, error: "invalid_input" };
  const started = d.now();
  const steps: StepTrace[] = [];
  const outputs: unknown[] = [];
  let stop: string | null = null;

  for (let i = 0; i < v.config.steps.length; i++) {
    const s = v.config.steps[i]!;
    const cap = CAPABILITY_BY_ID[s.capabilityId]!;
    const ad = CANVAS_ADAPTERS[s.capabilityId];
    if (stop) { steps.push({ step: i, capabilityId: cap.id, status: "not_run", reason: stop }); continue; }
    if (!ad) { stop = `Step ${i + 1} has no worker handler.`; steps.push({ step: i, capabilityId: cap.id, status: "failed", input: null, error: "unsupported" }); continue; }
    let value: string | null;
    if (!s.from) value = entryValue.trim();
    else {
      const src = CAPABILITY_BY_ID[v.config.steps[s.from.step]!.capabilityId]!;
      const o = src.outputs.find((x) => x.id === s.from!.output)!;
      value = pick(outputs[s.from.step], o.path);
      if (!value || !validValue(cap.input.kind, value)) {
        stop = `Step ${s.from.step + 1} returned no ${o.label.toLowerCase()} to pass on.`;
        steps.push({ step: i, capabilityId: cap.id, status: "failed", input: null, error: "no_mapped_value" });
        continue;
      }
    }
    if (d.now() - started > DRY_RUN_TOTAL_MS) { stop = "Time limit reached."; steps.push({ step: i, capabilityId: cap.id, status: "failed", input: value, error: "timeout" }); continue; }
    if (!(await d.available(cap.toolId))) { stop = `${cap.name} isn't running on the execution worker.`; steps.push({ step: i, capabilityId: cap.id, status: "failed", input: value, error: "tool_not_deployed" }); continue; }
    const lim = await d.take();
    if (lim !== "ok") { stop = lim === "unavailable" ? "Rate limiting is unavailable." : "Rate limit reached. Try again shortly."; steps.push({ step: i, capabilityId: cap.id, status: "failed", input: value, error: lim === "unavailable" ? "unavailable" : "rate_limited" }); continue; }
    const r = await d.execute(JSON.stringify({ schema: ad.schema, toolId: cap.toolId, input: ad.input(value) }));
    if (!r.ok) { stop = `${cap.name} failed.`; steps.push({ step: i, capabilityId: cap.id, status: "failed", input: value, error: r.error }); continue; }
    if (JSON.stringify(r.out).length > STEP_OUTPUT_MAX_BYTES || !ad.check(r.out, value)) { stop = `${cap.name} returned an unexpected result.`; steps.push({ step: i, capabilityId: cap.id, status: "failed", input: value, error: "bad_response" }); continue; }
    outputs[i] = r.out;
    const next = v.config.steps[i + 1];
    const passed = next?.from?.step === i ? pick(r.out, cap.outputs.find((o) => o.id === next.from!.output)!.path) : null;
    const eid = (r.out as { executionId?: unknown }).executionId;
    steps.push({ step: i, capabilityId: cap.id, status: "ok", input: value, executionId: typeof eid === "string" ? eid : null, passed, result: r.out });
  }
  const complete = steps.every((s) => s.status === "ok");
  if (!v.config.ai) return { ok: true, dryRun: true, traceId: d.traceId, complete, steps };
  let ai: AiTrace;
  if (!complete) ai = { status: "not_run", reason: "An earlier step did not complete." };
  else if (!d.summarise) ai = { status: "not_run", reason: "The AI step runs only for a launched product with the creator's own AI key active." };
  else {
    const o = await d.summarise({ steps: steps.map((s) => (s.status === "ok" ? { tool: s.capabilityId, input: s.input, result: s.result } : null)) }).catch(() => ({ status: "unavailable" }));
    ai = o.status === "ok" && o.text ? { status: "ok", model: o.model ?? "", text: o.text } : { status: "failed", error: o.status };
  }
  return { ok: true, dryRun: true, traceId: d.traceId, complete: complete && ai.status === "ok", steps, ai };
}
