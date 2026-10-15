// Interactive UI for the five Entertainment & Experimental AI tools. Used on Tool Library pages (library relay)
// and on launched product pages (product runner) — same component, different `post`.
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { StatusMessage, buttonPrimary } from "@/components/mcpx/primitives";
import { CopyButton } from "@/components/mcpx/McpConnection";
import {
  AI_CLIENT_TIMEOUT_MS, AI_ENDPOINT, AI_MAX_HISTORY, AI_MAX_TEXT, AI_TOOL_BY_TEMPLATE, ARGUMENT_PERSONALITIES, CONSPIRACY_STYLES,
  GIBBERISH_STYLES, ROAST_INTENSITIES,
} from "@/lib/ai-tools/defs";
import { aiToolStatusQuery } from "@/lib/tools/status";
import { RunError, RunErrorView, postRun } from "@/components/mcpx/product-run/shared";
import { cn } from "@/lib/utils";
import { PlaygroundApp } from "./PlaygroundApps";
import { AI_PLAYGROUND_IDS } from "@/lib/ai-tools/defs";

type Out = Record<string, unknown>;
type Post = (input: Record<string, unknown>, signal: AbortSignal) => Promise<Out>;

async function postLibrary(toolId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Out> {
  let r: Response;
  try {
    r = await fetch(AI_ENDPOINT(toolId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(AI_CLIENT_TIMEOUT_MS)]) });
  } catch { throw new RunError(signal.aborted ? "network" : "timeout"); }
  const body = (await r.json().catch(() => null)) as Out | null;
  if (!r.ok || !body || !("schema" in body)) throw new RunError(((body?.["error"] as string) ?? "provider_error") as never);
  return body;
}

const field = "w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary";

function Chips<T extends string | number>({ label, options, value, onChange }: { label: string; options: readonly T[]; value: T; onChange(v: T): void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="label-mono text-xs text-subtle">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={String(o)} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
            className={cn("rounded-md border px-3 py-1.5 font-mono text-xs capitalize transition-colors", value === o ? "border-primary text-primary" : "border-border-strong text-muted-foreground hover:text-foreground")}>
            {String(o)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function useRun(post: Post) {
  const abort = useRef<AbortController | null>(null);
  return useMutation({ mutationFn: (i: Record<string, unknown>) => { abort.current?.abort(); abort.current = new AbortController(); return post(i, abort.current.signal); }, retry: false });
}

/** Tool Library page: posts to the library relay. */
export function AiLibraryApp({ templateId }: { templateId: string }) {
  const d = AI_TOOL_BY_TEMPLATE[templateId]!;
  return <AiToolApp templateId={templateId} post={(i, s) => postLibrary(d.toolId, i, s)} />;
}
/** Launched product page: posts to the product runner (same free bucket). */
export function AiProductApp({ templateId, slug }: { templateId: string; slug: string }) {
  return <AiToolApp templateId={templateId} post={(i, s) => postRun<Out>(slug, i, s)} />;
}

export function AiToolApp({ templateId, post }: { templateId: string; post: Post }) {
  const d = AI_TOOL_BY_TEMPLATE[templateId];
  const status = useQuery(aiToolStatusQuery(d?.toolId ?? "none"));
  if (!d) return null;
  const available = status.data?.available === true;
  return (
    <div className="space-y-3">
      {status.isPending ? <p className="font-mono text-xs text-subtle">Checking AI service…</p>
        : !available && <StatusMessage tone="warning" title="Not connected">This AI tool isn't switched on right now, so it can't run.</StatusMessage>}
      {(AI_PLAYGROUND_IDS as readonly string[]).includes(templateId)
        ? <PlaygroundApp templateId={templateId} post={post} available={available} />
        : templateId === "gibberish-ai" || templateId === "argument-machine"
        ? <ChatApp templateId={templateId} post={post} available={available} />
        : <SingleApp templateId={templateId} post={post} available={available} />}
      <p className="text-xs text-subtle">Entertainment only. AI-generated, clearly fictional and not advice.</p>
    </div>
  );
}

interface Turn { role: "user" | "assistant"; text: string }

function ChatApp({ templateId, post, available }: { templateId: "gibberish-ai" | "argument-machine"; post: Post; available: boolean }) {
  const gib = templateId === "gibberish-ai";
  const opts = gib ? GIBBERISH_STYLES : ARGUMENT_PERSONALITIES;
  const [mode, setMode] = useState<string>(opts[0]);
  const [msg, setMsg] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const run = useRun(post);
  const send = (e?: React.FormEvent) => {
    e?.preventDefault();
    const m = msg.trim();
    if (!m || !available || run.isPending) return;
    const history = turns.slice(-AI_MAX_HISTORY).map((t) => ({ role: t.role, text: t.text.slice(0, AI_MAX_TEXT) }));
    const input = { message: m, [gib ? "style" : "personality"]: mode, ...(history.length ? { history } : {}) };
    setTurns((t) => [...t, { role: "user", text: m }]); setMsg("");
    run.mutate(input, { onSuccess: (o) => setTurns((t) => [...t, { role: "assistant", text: String(o["reply"] ?? "") }]) });
  };
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <Chips<string> label={gib ? "Style" : "Personality"} options={opts} value={mode} onChange={setMode} />
      <div aria-live="polite" className="max-h-96 space-y-2 overflow-y-auto rounded-md border border-border bg-background p-3">
        {turns.length === 0 && <p className="text-sm text-subtle">{gib ? "Say anything. Expect nothing useful." : "Say anything. It will disagree."}</p>}
        {turns.map((t, i) => (
          <div key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-lg px-3 py-2 text-sm", t.role === "user" ? "bg-primary text-primary-foreground" : "border border-border-strong bg-surface-2 text-foreground")}>
              <p className="whitespace-pre-wrap break-words">{t.text}</p>
              {t.role === "assistant" && <div className="mt-1 flex justify-end"><CopyButton text={t.text} label="Copy" /></div>}
            </div>
          </div>
        ))}
        {run.isPending && <p className="font-mono text-xs text-subtle">{gib ? "Generating nonsense…" : "Preparing a counterargument…"}</p>}
      </div>
      {run.isError && <RunErrorView error={run.error} />}
      <form onSubmit={send} className="flex gap-2">
        <label htmlFor="ai-msg" className="sr-only">Message</label>
        <input id="ai-msg" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={AI_MAX_TEXT} autoComplete="off" placeholder={gib ? "Ask Gibberish AI something…" : "Make a claim…"} className={cn(field, "min-w-0 flex-1")} />
        <button type="submit" className={buttonPrimary} disabled={!available || run.isPending || !msg.trim()}>{gib ? "Send" : "Submit"}</button>
      </form>
      {turns.length > 0 && <button type="button" className="text-xs text-muted-foreground underline underline-offset-4" onClick={() => { setTurns([]); run.reset(); }}>Clear conversation</button>}
    </div>
  );
}

function SingleApp({ templateId, post, available }: { templateId: string; post: Post; available: boolean }) {
  const cfg = {
    "roast-bot": { label: "What should be roasted?", placeholder: "My 47 open browser tabs", key: "subject", optKey: "intensity", optLabel: "Intensity", opts: ROAST_INTENSITIES as readonly (string | number)[], cta: "Roast Me", busy: "Sharpening insults…" },
    "excuse-machine": { label: "The situation", placeholder: "I was late to my own birthday party", key: "situation", optKey: "absurdity", optLabel: "Absurdity", opts: [1, 2, 3, 4, 5] as readonly (string | number)[], cta: "Generate Excuse", busy: "Fabricating…" },
    "conspiracy-potato": { label: "Topic to investigate", placeholder: "Why socks disappear in the dryer", key: "topic", optKey: "style", optLabel: "Style", opts: CONSPIRACY_STYLES as readonly (string | number)[], cta: "Generate Theory", busy: "Connecting the strings…" },
  }[templateId];
  const [val, setVal] = useState("");
  const [opt, setOpt] = useState<string | number>(cfg?.opts[cfg.optKey === "absurdity" ? 2 : 0] ?? "");
  const run = useRun(post);
  if (!cfg) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!val.trim() || !available || run.isPending) return;
    run.mutate({ [cfg.key]: val.trim(), [cfg.optKey]: opt });
  };
  const o = run.data;
  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <label htmlFor="ai-in" className="label-mono block text-xs text-subtle">{cfg.label}</label>
          <input id="ai-in" value={val} onChange={(e) => setVal(e.target.value)} maxLength={AI_MAX_TEXT} autoComplete="off" placeholder={cfg.placeholder} className={field} />
        </div>
        <Chips label={cfg.optLabel} options={cfg.opts} value={opt} onChange={setOpt} />
        <button type="submit" className={buttonPrimary} disabled={!available || run.isPending || !val.trim()}>{run.isPending ? cfg.busy : cfg.cta}</button>
      </form>
      {run.isError && <RunErrorView error={run.error} onRetry={() => run.mutate({ [cfg.key]: val.trim(), [cfg.optKey]: opt })} disabled={run.isPending} />}
      {o && !run.isPending && <AiResult templateId={templateId} o={o} />}
    </div>
  );
}

export function AiResult({ templateId, o }: { templateId: string; o: Out }) {
  if (templateId === "conspiracy-potato") {
    const clues = Array.isArray(o["clues"]) ? (o["clues"] as string[]) : [];
    const share = `${String(o["headline"])}\n\n${String(o["theory"])}\n\n${clues.map((c, i) => `Clue ${i + 1}: ${c}`).join("\n")}\n\nConclusion: ${String(o["conclusion"])}`;
    return (
      <section aria-label="Investigation board" className="space-y-3 rounded-lg border border-primary/40 bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold uppercase tracking-tight text-primary">{String(o["headline"])}</h3>
          <CopyButton text={share} label="Copy" />
        </div>
        <p className="text-sm leading-relaxed text-foreground">{String(o["theory"])}</p>
        <ol className="grid gap-2 sm:grid-cols-3">
          {clues.map((c, i) => (
            <li key={i} className="rounded-md border border-dashed border-border-strong bg-surface-2 p-3 text-sm text-muted-foreground">
              <span className="label-mono block text-[10px] text-primary">Exhibit {String.fromCharCode(65 + i)}</span>{c}
            </li>
          ))}
        </ol>
        <p className="border-t border-border pt-3 text-sm font-medium text-foreground"><span className="label-mono mr-2 text-xs text-subtle">Conclusion</span>{String(o["conclusion"])}</p>
      </section>
    );
  }
  const text = String(o["roast"] ?? o["excuse"] ?? o["reply"] ?? "");
  const tag = templateId === "roast-bot" ? `Intensity: ${String(o["intensity"])}` : templateId === "excuse-machine" ? `Absurdity ${String(o["absurdity"])}/5` : "";
  return (
    <section aria-label="Result" className="space-y-3 rounded-lg border border-primary/40 bg-card p-5">
      <p className="text-xl font-medium leading-snug text-foreground sm:text-2xl">{text}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono text-xs text-subtle">{tag}</span>
        <CopyButton text={text} label="Copy" />
      </div>
    </section>
  );
}
