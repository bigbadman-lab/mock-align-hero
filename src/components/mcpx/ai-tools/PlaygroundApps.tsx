// AI Playground mini-apps (Future You, Web3 Startup Roulette, Monster Factory, Pigeon CEO).
// Same `post` contract as AiToolApp: Tool Library relay or launched-product runner.
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { buttonPrimary } from "@/components/mcpx/primitives";
import { CopyButton } from "@/components/mcpx/McpConnection";
import { RunErrorView } from "@/components/mcpx/product-run/shared";
import {
  AI_MAX_TEXT, CEO_STYLES, CEO_URGENCY, FUTURE_PERSONALITIES, FUTURE_YEARS, MONSTER_RARITIES, MONSTER_TEMPERAMENTS, STARTUP_SECTORS,
} from "@/lib/ai-tools/defs";
import { cn } from "@/lib/utils";

type Out = Record<string, unknown>;
type Post = (input: Record<string, unknown>, signal: AbortSignal) => Promise<Out>;
const S = (v: unknown) => (v == null ? "" : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const field = "w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary";

function Chips<T extends string | number>({ label, options, value, onChange, fmt }: { label: string; options: readonly T[]; value: T; onChange(v: T): void; fmt?(v: T): string }) {
  return (
    <fieldset className="space-y-1">
      <legend className="label-mono text-xs text-subtle">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={String(o)} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
            className={cn("rounded-md border px-3 py-1.5 font-mono text-xs capitalize transition-colors", value === o ? "border-primary text-primary" : "border-border-strong text-muted-foreground hover:text-foreground")}>
            {fmt ? fmt(o) : String(o)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Input({ id, label, value, onChange, placeholder, area }: { id: string; label: string; value: string; onChange(v: string): void; placeholder: string; area?: boolean }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="label-mono block text-xs text-subtle">{label}</label>
      {area
        ? <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} maxLength={AI_MAX_TEXT} placeholder={placeholder} className={cn(field, "resize-y")} />
        : <input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={AI_MAX_TEXT} autoComplete="off" placeholder={placeholder} className={field} />}
    </div>
  );
}

function useRun(post: Post) {
  const abort = useRef<AbortController | null>(null);
  return useMutation({ mutationFn: (i: Record<string, unknown>) => { abort.current?.abort(); abort.current = new AbortController(); return post(i, abort.current.signal); }, retry: false });
}

function Shell({ form, run, input, cta, busy, ready, available, result, again }: {
  form: React.ReactNode; run: ReturnType<typeof useRun>; input: Record<string, unknown>; cta: string; busy: string; ready: boolean; available: boolean;
  result(o: Out): React.ReactNode; again: string;
}) {
  const go = () => { if (ready && available && !run.isPending) run.mutate(input); };
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); go(); }} className="space-y-3 rounded-lg border border-border bg-card p-4">
        {form}
        <button type="submit" className={buttonPrimary} disabled={!available || run.isPending || !ready}>{run.isPending ? busy : cta}</button>
      </form>
      {run.isPending && <div className="h-1 w-full overflow-hidden rounded bg-surface-2"><div className="h-full w-1/3 animate-pulse bg-primary" /></div>}
      {run.isError && <RunErrorView error={run.error} onRetry={go} disabled={run.isPending} />}
      {run.data && !run.isPending && (
        <>
          {result(run.data)}
          <button type="button" onClick={go} disabled={!available} className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">{again}</button>
        </>
      )}
    </div>
  );
}

function FutureYou({ post, available }: { post: Post; available: boolean }) {
  const [situation, setSituation] = useState("");
  const [years, setYears] = useState<number>(10);
  const [personality, setP] = useState<string>("wise");
  const run = useRun(post);
  return <Shell run={run} available={available} ready={!!situation.trim()} cta="Meet Future Me" busy="Opening the time portal…" again="Generate another letter"
    input={{ situation: situation.trim(), years_ahead: years, personality }}
    form={<>
      <Input id="fy-sit" area label="Your situation right now" value={situation} onChange={setSituation} placeholder="Thinking about quitting my job to build a crypto app" />
      <Chips label="Timeline" options={FUTURE_YEARS} value={years as (typeof FUTURE_YEARS)[number]} onChange={setYears} fmt={(y) => `+${y} yr${y > 1 ? "s" : ""}`} />
      <Chips label="Future self" options={FUTURE_PERSONALITIES} value={personality as (typeof FUTURE_PERSONALITIES)[number]} onChange={setP} />
    </>}
    result={(o) => {
      const share = `${S(o["title"])}\n${S(o["timeline"])}\n\n${S(o["letter"])}\n\nAdvice: ${S(o["advice"])}\n"${S(o["closing_quote"])}"`;
      return (
        <section aria-label="Letter from your future self" className="relative overflow-hidden rounded-lg border border-primary/40 bg-card p-5 sm:p-6">
          <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full border border-primary/20" />
          <div className="flex items-start justify-between gap-2">
            <p className="label-mono text-xs text-primary">⧗ {S(o["timeline"])}</p>
            <CopyButton text={share} label="Copy" />
          </div>
          <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{S(o["title"])}</h3>
          <p className="mt-3 whitespace-pre-wrap font-mono text-sm leading-relaxed text-muted-foreground">{S(o["letter"])}</p>
          <div className="mt-4 rounded-md border border-dashed border-primary/40 bg-surface-2 p-3">
            <span className="label-mono block text-[10px] text-primary">Advice from the future</span>
            <p className="text-sm font-medium text-foreground">{S(o["advice"])}</p>
          </div>
          <p className="mt-3 text-right text-sm italic text-subtle">“{S(o["closing_quote"])}” — Future You</p>
        </section>
      );
    }} />;
}

function Roulette({ post, available }: { post: Post; available: boolean }) {
  const [keywords, setK] = useState("");
  const [sector, setSector] = useState<string>("random");
  const [absurdity, setA] = useState<number>(3);
  const run = useRun(post);
  return <Shell run={run} available={available} ready cta="Generate Startup" busy="Raising a seed round…" again="Spin again"
    input={{ ...(keywords.trim() ? { keywords: keywords.trim() } : {}), sector, absurdity }}
    form={<>
      <Chips label="Sector" options={STARTUP_SECTORS} value={sector as (typeof STARTUP_SECTORS)[number]} onChange={setSector} />
      <Chips label="Absurdity" options={[1, 2, 3, 4, 5] as const} value={absurdity as 1} onChange={setA} />
      <Input id="ws-k" label="Keywords (optional)" value={keywords} onChange={setK} placeholder="frogs, yield, toaster" />
    </>}
    result={(o) => {
      const tk = arr(o["tokenomics"]);
      const share = `${S(o["name"])} ($${S(o["ticker"])}) — ${S(o["pitch"])}\n\nProblem: ${S(o["problem"])}\nSolution: ${S(o["solution"])}\nToken utility: ${S(o["token_utility"])}\nTokenomics:\n${tk.map((x) => `• ${x}`).join("\n")}\nValuation: ${S(o["valuation"])}\n\n${S(o["investor_pitch"])}\n"${S(o["founder_quote"])}"\n\n(Fictional parody — not a real project or financial advice.)`;
      return (
        <section aria-label="Startup pitch" className="space-y-4 rounded-lg border border-primary/40 bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="label-mono text-[10px] text-subtle">Pitch deck · {S(o["sector"])} · absurdity {S(o["absurdity"])}/5</p>
              <h3 className="text-2xl font-semibold tracking-tight text-foreground">{S(o["name"])} <span className="font-mono text-base text-primary">${S(o["ticker"])}</span></h3>
              <p className="mt-1 text-sm text-muted-foreground">{S(o["pitch"])}</p>
            </div>
            <CopyButton text={share} label="Copy pitch" />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {([["Problem", "problem"], ["Solution", "solution"], ["Token utility", "token_utility"]] as const).map(([l, k]) => (
              <div key={k} className="rounded-md border border-border-strong bg-surface-2 p-3"><span className="label-mono block text-[10px] text-primary">{l}</span><p className="text-sm text-foreground">{S(o[k])}</p></div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <span className="label-mono block text-[10px] text-subtle">Satirical tokenomics</span>
              <ul className="mt-1 space-y-1">{tk.map((x, i) => <li key={i} className="flex gap-2 text-sm text-muted-foreground"><span className="text-primary">▸</span>{x}</li>)}</ul>
            </div>
            <div className="rounded-md border border-primary/40 p-3 text-center sm:min-w-40">
              <span className="label-mono block text-[10px] text-subtle">Imaginary valuation</span>
              <p className="font-mono text-lg font-semibold text-primary">{S(o["valuation"])}</p>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-foreground">{S(o["investor_pitch"])}</p>
          <p className="border-t border-border pt-3 text-sm italic text-subtle">“{S(o["founder_quote"])}” — the founder</p>
          <p className="text-[11px] text-subtle">Fictional parody. Not a real project, token or investment.</p>
        </section>
      );
    }} />;
}

function Monster({ post, available }: { post: Post; available: boolean }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [temperament, setT] = useState<string>("ridiculous");
  const [rarity, setR] = useState<string>("random");
  const run = useRun(post);
  return <Shell run={run} available={available} ready={!!a.trim() && !!b.trim()} cta="Create Monster" busy="Mixing ingredients…" again="Create another monster"
    input={{ ingredient_one: a.trim(), ingredient_two: b.trim(), temperament, rarity }}
    form={<>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <Input id="mf-a" label="Ingredient one" value={a} onChange={setA} placeholder="Octopus" />
        <span aria-hidden className="hidden pb-2 font-mono text-lg text-primary sm:block">+</span>
        <Input id="mf-b" label="Ingredient two" value={b} onChange={setB} placeholder="Vending machine" />
      </div>
      <Chips label="Temperament" options={MONSTER_TEMPERAMENTS} value={temperament as (typeof MONSTER_TEMPERAMENTS)[number]} onChange={setT} />
      <Chips label="Rarity" options={MONSTER_RARITIES} value={rarity as (typeof MONSTER_RARITIES)[number]} onChange={setR} />
    </>}
    result={(o) => {
      const ab = arr(o["abilities"]);
      const share = `${S(o["name"])} — ${S(o["species"])} (${S(o["rarity"])})\n\n${S(o["appearance"])}\n\nAbilities:\n${ab.map((x) => `• ${x}`).join("\n")}\nWeakness: ${S(o["weakness"])}\nPersonality: ${S(o["personality"])}\nHabitat: ${S(o["habitat"])}\n\nOrigin: ${S(o["origin"])}\nFact: ${S(o["fact"])}`;
      const legendary = S(o["rarity"]) === "legendary";
      return (
        <section aria-label="Monster profile card" className={cn("mx-auto max-w-lg space-y-3 rounded-xl border-2 bg-card p-5", legendary ? "border-primary" : "border-border-strong")}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-2xl font-semibold tracking-tight text-foreground">{S(o["name"])}</h3>
              <p className="font-mono text-xs text-muted-foreground">{S(o["species"])} · {S(o["temperament"])}</p>
            </div>
            <span className={cn("rounded border px-2 py-0.5 font-mono text-[11px] uppercase", legendary ? "border-primary text-primary" : "border-border-strong text-subtle")}>★ {S(o["rarity"])}</span>
          </div>
          <p className="rounded-md bg-surface-2 p-3 text-sm leading-relaxed text-foreground">{S(o["appearance"])}</p>
          <div>
            <span className="label-mono block text-[10px] text-primary">Abilities</span>
            <ol className="mt-1 space-y-1">{ab.map((x, i) => <li key={i} className="flex gap-2 text-sm text-foreground"><span className="font-mono text-primary">{i + 1}</span>{x}</li>)}</ol>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            {([["Weakness", "weakness"], ["Personality", "personality"], ["Habitat", "habitat"]] as const).map(([l, k]) => (
              <div key={k} className="rounded-md border border-border p-2"><dt className="label-mono text-[10px] text-subtle">{l}</dt><dd className="text-muted-foreground">{S(o[k])}</dd></div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground"><span className="label-mono mr-2 text-[10px] text-subtle">Origin</span>{S(o["origin"])}</p>
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <p className="text-xs italic text-subtle">Fun fact: {S(o["fact"])}</p>
            <CopyButton text={share} label="Copy" />
          </div>
        </section>
      );
    }} />;
}

function Pigeon({ post, available }: { post: Post; available: boolean }) {
  const [problem, setProblem] = useState("");
  const [style, setStyle] = useState<string>("visionary");
  const [urgency, setU] = useState<string>("medium");
  const run = useRun(post);
  return <Shell run={run} available={available} ready={!!problem.trim()} cta="Consult the CEO" busy="The CEO is pecking at a keyboard…" again="Ask another question"
    input={{ business_problem: problem.trim(), management_style: style, urgency }}
    form={<>
      <Input id="pc-p" area label="Business problem" value={problem} onChange={setProblem} placeholder="Our team keeps missing deadlines" />
      <Chips label="Management style" options={CEO_STYLES} value={style as (typeof CEO_STYLES)[number]} onChange={setStyle} />
      <Chips label="Urgency" options={CEO_URGENCY} value={urgency as (typeof CEO_URGENCY)[number]} onChange={setU} />
    </>}
    result={(o) => {
      const items = arr(o["action_items"]);
      const conf = Number(o["confidence"]) || 0;
      const share = `MEMO — Office of the Pigeon CEO\n\n${S(o["opening"])}\n\nRecommendation: ${S(o["recommendation"])}\n\nAction items:\n${items.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nImpact: ${S(o["impact"])}\nCEO confidence: ${conf}%\n\n"${S(o["closing_quote"])}"`;
      return (
        <section aria-label="Executive memo" className="space-y-3 rounded-lg border border-primary/40 bg-card p-5 font-mono">
          <div className="flex items-start justify-between gap-2 border-b border-border pb-2">
            <div className="text-xs text-subtle">
              <p><span className="text-foreground">MEMO</span> · Office of the CEO, Coo Corp International</p>
              <p>Style: {S(o["management_style"])} · Urgency: {S(o["urgency"])}</p>
            </div>
            <CopyButton text={share} label="Copy memo" />
          </div>
          <p className="font-sans text-base font-medium text-foreground">{S(o["opening"])}</p>
          <p className="font-sans text-sm text-muted-foreground"><span className="label-mono mr-2 text-[10px] text-primary">Recommendation</span>{S(o["recommendation"])}</p>
          <ol className="space-y-1">{items.map((x, i) => <li key={i} className="flex gap-2 font-sans text-sm text-foreground"><span className="text-primary">☐</span>{x}</li>)}</ol>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
            <p className="font-sans text-sm text-muted-foreground"><span className="label-mono mr-2 text-[10px] text-subtle">Impact</span>{S(o["impact"])}</p>
            <div className="sm:w-44">
              <span className="label-mono block text-[10px] text-subtle">CEO confidence (fictional)</span>
              <div className="mt-1 h-2 w-full overflow-hidden rounded bg-surface-2"><div className="h-full bg-primary" style={{ width: `${Math.min(100, conf)}%` }} /></div>
              <p className="text-right text-sm text-primary">{conf}%</p>
            </div>
          </div>
          <p className="border-t border-border pt-2 font-sans text-sm italic text-subtle">“{S(o["closing_quote"])}” — The CEO 🐦</p>
        </section>
      );
    }} />;
}

export function PlaygroundApp({ templateId, post, available }: { templateId: string; post: Post; available: boolean }) {
  if (templateId === "future-you") return <FutureYou post={post} available={available} />;
  if (templateId === "web3-startup-roulette") return <Roulette post={post} available={available} />;
  if (templateId === "monster-factory") return <Monster post={post} available={available} />;
  if (templateId === "pigeon-ceo") return <Pigeon post={post} available={available} />;
  return null;
}
