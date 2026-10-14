// Guided Canvas (Template 11) configuration inside the launch draft. Every choice comes from the
// server-owned catalog; the shared validator decides what is allowed. Dry runs call the real worker.
import { useState } from "react";
import { CAPABILITIES, CAPABILITY_BY_ID, CANVAS_CATALOG_VERSION, CANVAS_MAX_STEPS, CANVAS_MIN_STEPS } from "@/lib/canvas/catalog";
import { compatibleSources, validateCanvas, type CanvasConfig, type CanvasStepInput } from "@/lib/canvas/validate";
import type { DryRun, StepTrace } from "@/lib/canvas/run";
import { buttonOutline } from "@/components/mcpx/primitives";

export const EMPTY_CANVAS: CanvasConfig = { catalogVersion: CANVAS_CATALOG_VERSION, steps: [] };

const inputCls = "mt-1 block w-full rounded-md border border-border-strong bg-background p-2 text-sm text-foreground";

export function CanvasBuilder({ value, onChange, err, signedIn }: { value: CanvasConfig | null | undefined; onChange: (c: CanvasConfig) => void; err?: string | undefined; signedIn: boolean }) {
  const cfg = value ?? EMPTY_CANVAS;
  const steps = cfg.steps;
  const check = validateCanvas(cfg);
  const used = new Set(steps.map((s) => s.capabilityId));
  const [adding, setAdding] = useState("");

  const write = (next: CanvasStepInput[]) => {
    // Re-point each step to its first compatible source; drop links that no longer fit after edits.
    const fixed = next.map((s, i) => {
      if (i === 0) return { capabilityId: s.capabilityId, version: s.version };
      const opts = compatibleSources(next, i);
      const keep = s.from && opts.some((o) => o.step === s.from!.step && o.output === s.from!.output);
      const from = keep ? s.from : opts[0] ? { step: opts[0].step, output: opts[0].output } : undefined;
      return from ? { ...s, from } : { capabilityId: s.capabilityId, version: s.version };
    });
    onChange({ catalogVersion: CANVAS_CATALOG_VERSION, steps: fixed });
  };
  const add = () => { const c = CAPABILITY_BY_ID[adding]; if (!c) return; write([...steps, { capabilityId: c.id, version: c.version }]); setAdding(""); };
  const move = (i: number, d: -1 | 1) => { const n = [...steps]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; write(n.map((s) => ({ capabilityId: s.capabilityId, version: s.version, ...(s.from ? { from: s.from } : {}) }))); };
  const remove = (i: number) => write(steps.filter((_, k) => k !== i).map((s) => ({ capabilityId: s.capabilityId, version: s.version })));
  const setFrom = (i: number, v: string) => { const [step, output] = v.split("|"); write(steps.map((s, k) => (k === i ? { ...s, from: { step: Number(step), output: output! } } : s))); };

  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4 text-sm" aria-describedby="canvas-err">
      <div>
        <p className="text-foreground">Canvas pipeline</p>
        <p className="mt-1 text-muted-foreground">Pick {CANVAS_MIN_STEPS}–{CANVAS_MAX_STEPS} tools in order. Step 1 takes the caller's input; each later step reads one approved value from an earlier step. No code, links or outside services.</p>
      </div>

      {steps.length === 0 ? <p className="text-subtle">No steps yet.</p> : (
        <ol className="space-y-3">
          {steps.map((s, i) => {
            const c = CAPABILITY_BY_ID[s.capabilityId];
            const opts = compatibleSources(steps, i);
            return (
              <li key={`${s.capabilityId}-${i}`} className="rounded-md border border-border-strong bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-primary">STEP {i + 1}</span>
                  <span className="flex-1 text-foreground">{c?.name ?? s.capabilityId}</span>
                  <div className="flex gap-1">
                    <button type="button" className={buttonOutline + " px-2 py-1 text-xs"} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>↑</button>
                    <button type="button" className={buttonOutline + " px-2 py-1 text-xs"} onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`}>↓</button>
                    <button type="button" className={buttonOutline + " px-2 py-1 text-xs"} onClick={() => remove(i)} aria-label={`Remove step ${i + 1}`}>Remove</button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Needs: {c?.input.label}{c && c.outputs.length ? ` · Can pass on: ${c.outputs.map((o) => o.label).join(", ")}` : " · Passes nothing on (end step)"}</p>
                {i === 0 ? <p className="mt-2 text-xs text-subtle">Input: provided by the caller.</p> : opts.length ? (
                  <label className="mt-2 block text-xs">
                    <span className="text-muted-foreground">{c?.input.label} comes from</span>
                    <select className={inputCls} value={s.from ? `${s.from.step}|${s.from.output}` : ""} onChange={(e) => setFrom(i, e.target.value)}>
                      {opts.map((o) => <option key={`${o.step}|${o.output}`} value={`${o.step}|${o.output}`}>{o.label}</option>)}
                    </select>
                  </label>
                ) : <p className="mt-2 text-xs text-warning">No earlier step provides a {c?.input.label.toLowerCase()}. Reorder or pick another tool.</p>}
              </li>
            );
          })}
        </ol>
      )}

      {steps.length < CANVAS_MAX_STEPS && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block flex-1 text-xs">
            <span className="text-muted-foreground">Add a step</span>
            <select className={inputCls} value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose a tool…</option>
              {CAPABILITIES.filter((c) => !used.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name} — needs {c.input.label.toLowerCase()}</option>)}
            </select>
          </label>
          <button type="button" className={buttonOutline} onClick={add} disabled={!adding}>Add step</button>
        </div>
      )}

      <div role="status" className={`rounded-md border p-3 text-xs ${check.ok ? "border-primary/40 text-primary" : "border-border-strong text-muted-foreground"}`}>
        {check.ok ? `Valid pipeline · ${steps.length} steps · input: ${CAPABILITY_BY_ID[steps[0]!.capabilityId]!.input.label.toLowerCase()}` : check.errors.map((e) => <p key={e}>{e}</p>)}
      </div>
      {err && <p id="canvas-err" className="text-xs text-destructive">{err}</p>}

      {check.ok && <DryRunPanel config={check.config} label={CAPABILITY_BY_ID[check.config.steps[0]!.capabilityId]!.input.label} signedIn={signedIn} />}
    </div>
  );
}

function DryRunPanel({ config, label, signedIn }: { config: CanvasConfig; label: string; signedIn: boolean }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ k: "idle" } | { k: "running" } | { k: "done"; r: Extract<DryRun, { ok: true }> } | { k: "error"; msg: string }>({ k: "idle" });
  if (!signedIn) return <p className="text-xs text-subtle">Sign in as a creator to try a dry run of this pipeline.</p>;
  const run = async () => {
    setState({ k: "running" });
    try {
      const res = await fetch("/api/creator/canvas-dry-run", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify({ canvas: config, input: value.trim() }) });
      const b = (await res.json().catch(() => null)) as (DryRun & { error?: string }) | null;
      if (res.ok && b?.ok) return setState({ k: "done", r: b });
      const e = b && "error" in b ? b.error : null;
      setState({ k: "error", msg: e === "invalid_input" ? `Enter a valid ${label.toLowerCase()}.` : e === "worker_not_configured" ? "The execution service isn't connected, so dry runs aren't available." : e === "unauthorized" ? "Your creator session expired. Sign in again." : res.status === 429 ? "Too many requests. Try again shortly." : "Dry run unavailable right now." });
    } catch { setState({ k: "error", msg: "Network error. Try again." }); }
  };
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <p className="font-mono text-xs text-warning">DRY RUN — real reads, not a live product. No MCP endpoint exists until the token launches.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block flex-1 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <input className={inputCls + " font-mono"} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        <button type="button" className={buttonOutline} onClick={run} disabled={!value.trim() || state.k === "running"}>{state.k === "running" ? "Running…" : "Run dry run"}</button>
      </div>
      {state.k === "error" && <p role="alert" className="text-xs text-destructive">{state.msg}</p>}
      {state.k === "done" && (
        <div className="space-y-2" aria-live="polite">
          <p className="font-mono text-[11px] text-subtle">Trace {state.r.traceId} · {state.r.complete ? "all steps completed" : "stopped early"}</p>
          {state.r.steps.map((s) => <TraceRow key={s.step} s={s} />)}
        </div>
      )}
    </div>
  );
}

function TraceRow({ s }: { s: StepTrace }) {
  const name = CAPABILITY_BY_ID[s.capabilityId]?.name ?? s.capabilityId;
  return (
    <details className="rounded-md border border-border-strong bg-background p-2 text-xs">
      <summary className="cursor-pointer">
        <span className={s.status === "ok" ? "text-primary" : s.status === "failed" ? "text-destructive" : "text-subtle"}>{s.status.toUpperCase().replace("_", " ")}</span>
        <span className="ml-2 text-foreground">Step {s.step + 1} · {name}</span>
        {s.status === "failed" && <span className="ml-2 text-muted-foreground">({s.error})</span>}
        {s.status === "not_run" && <span className="ml-2 text-muted-foreground">{s.reason}</span>}
      </summary>
      {s.status === "ok" && (
        <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
          <p className="break-all">input: {s.input}</p>
          {s.passed && <p className="break-all text-primary">passed on: {s.passed}</p>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(s.result, null, 2)}</pre>
        </div>
      )}
    </details>
  );
}
