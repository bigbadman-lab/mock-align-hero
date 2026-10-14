// Pure Canvas configuration validator, shared by browser and server so they can't drift.
// MVP shape: an ordered pipeline. Step 1 takes the caller's input; each later step takes exactly one
// earlier step's catalog output. No branching, loops, repeats, scripts, URLs or headers.
import { CANVAS_CATALOG_VERSION, CANVAS_MAX_STEPS, CANVAS_MIN_STEPS, CAPABILITY_BY_ID, kindAccepts, type ValueKind } from "./catalog";

export interface CanvasStepInput {
  capabilityId: string;
  version: number;
  /** Absent for step 0; otherwise an earlier step index and one of its output ids. */
  from?: { step: number; output: string };
}
export interface CanvasConfig { catalogVersion: number; steps: CanvasStepInput[] }

export type CanvasCheck = { ok: true; config: CanvasConfig; entryKind: ValueKind } | { ok: false; errors: string[] };

const ALLOWED_KEYS = new Set(["capabilityId", "version", "from"]);

export function validateCanvas(raw: unknown): CanvasCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["Canvas configuration is missing."] };
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== "catalogVersion" && k !== "steps")) return { ok: false, errors: ["Canvas configuration has unexpected fields."] };
  if (r.catalogVersion !== CANVAS_CATALOG_VERSION) return { ok: false, errors: ["This Canvas was built for a different capability catalog. Rebuild it."] };
  if (!Array.isArray(r.steps)) return { ok: false, errors: ["Add at least two steps."] };
  const steps = r.steps as unknown[];
  if (steps.length < CANVAS_MIN_STEPS) errors.push(`Add at least ${CANVAS_MIN_STEPS} steps.`);
  if (steps.length > CANVAS_MAX_STEPS) return { ok: false, errors: [`Use ${CANVAS_MAX_STEPS} steps or fewer.`] };

  const seen = new Set<string>();
  const out: CanvasStepInput[] = [];
  steps.forEach((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== "object" || Object.keys(s).some((k) => !ALLOWED_KEYS.has(k))) { errors.push(`Step ${n} is malformed.`); return; }
    const st = s as { capabilityId?: unknown; version?: unknown; from?: unknown };
    const c = typeof st.capabilityId === "string" ? CAPABILITY_BY_ID[st.capabilityId] : undefined;
    if (!c) { errors.push(`Step ${n} uses a capability that isn't available.`); return; }
    if (st.version !== c.version) { errors.push(`Step ${n} (${c.name}) uses an outdated version.`); return; }
    if (seen.has(c.id)) { errors.push(`Step ${n}: ${c.name} is already used. Each tool can appear once.`); return; }
    seen.add(c.id);
    if (i === 0) {
      if (st.from !== undefined) { errors.push("Step 1 takes the caller's input and can't read from another step."); return; }
      out.push({ capabilityId: c.id, version: c.version });
      return;
    }
    const f = st.from as { step?: unknown; output?: unknown } | undefined;
    if (!f || typeof f !== "object" || typeof f.step !== "number" || typeof f.output !== "string") { errors.push(`Step ${n} (${c.name}) needs a ${c.input.label.toLowerCase()} from an earlier step.`); return; }
    if (!Number.isInteger(f.step) || f.step < 0 || f.step >= i) { errors.push(`Step ${n} can only read from an earlier step.`); return; }
    const src = out[f.step] ? CAPABILITY_BY_ID[out[f.step]!.capabilityId] : undefined;
    const o = src?.outputs.find((x) => x.id === f.output);
    if (!src || !o) { errors.push(`Step ${n}: that output doesn't exist on the chosen step.`); return; }
    if (!kindAccepts(c.input.kind, o.kind)) { errors.push(`${c.name} needs a ${c.input.label.toLowerCase()}; ${src.name}'s "${o.label}" isn't one.`); return; }
    out.push({ capabilityId: c.id, version: c.version, from: { step: f.step, output: o.id } });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { catalogVersion: CANVAS_CATALOG_VERSION, steps: out }, entryKind: CAPABILITY_BY_ID[out[0]!.capabilityId]!.input.kind };
}

/** Outputs that a step at index `i` may legally read, for the guided picker. */
export function compatibleSources(steps: CanvasStepInput[], i: number) {
  const c = CAPABILITY_BY_ID[steps[i]?.capabilityId ?? ""];
  if (!c) return [];
  return steps.slice(0, i).flatMap((s, idx) =>
    (CAPABILITY_BY_ID[s.capabilityId]?.outputs ?? []).filter((o) => kindAccepts(c.input.kind, o.kind)).map((o) => ({ step: idx, output: o.id, label: `Step ${idx + 1} · ${o.label}` })));
}
