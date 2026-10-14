import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, PageHeader, StatusMessage, SectionHeading, RouteError, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { LIBRARY, TEMPLATES, resolveTemplateParam } from "@/lib/templates";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
import { WW_THRESHOLDS, WW_DEFAULT_THRESHOLD } from "@/lib/tools/whale-watch";
import { useWallet } from "@/lib/wallet/context";
import { shortAddress } from "@/lib/wallet/state";
import { FEE_SPLIT, LIMITS, draftSummary, templateSettingsMode, validateDraft, type Draft, type DraftInput, type FieldErrors } from "@/lib/launch/draft";
import type { ReadinessItem, ReadyState } from "@/lib/launch/readiness";
import { getLaunchReadiness } from "@/lib/launch/readiness.functions";
import { LaunchTxCheck } from "@/components/mcpx/launch/LaunchTxCheck";
import { CanvasBuilder, EMPTY_CANVAS } from "@/components/mcpx/launch/CanvasBuilder";
import { CANVAS_TEMPLATE_ID } from "@/lib/launch/draft";
import { ArtworkPanel, MetadataPanel, SavedDrafts, useDrafts, type DraftView } from "@/components/mcpx/launch/DraftPersistence";

export const Route = createFileRoute("/launch")({
  // ?template= is a hint only; it is resolved through resolveTemplateParam and never trusted as a draft field.
  validateSearch: (s: Record<string, unknown>): { template?: string } => (typeof s["template"] === "string" ? { template: s["template"] as string } : {}),
  head: () => ({
    meta: [
      { title: "Launch preparation — MCPX" },
      { name: "description", content: "Prepare and validate an MCPX tool-token draft. Token creation is not available yet." },
      { property: "og:title", content: "Launch preparation — MCPX" },
      { property: "og:description", content: "Draft and check a tool token. Nothing is created or signed while launch prerequisites are missing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: async () => {
    try { return await getLaunchReadiness(); } catch { return null; }
  },
  staleTime: 60_000,
  component: Launch,
  errorComponent: RouteError,
});

const EMPTY: DraftInput = { templateId: "", settings: {}, productName: "", toolDescription: "", tokenName: "", symbol: "", description: "", link: "", buyEnabled: false, buyAmount: "", slippageBps: "100" };
const STATE_STYLE: Record<ReadyState, string> = {
  READY: "text-primary border-primary/40",
  NOT_CONFIGURED: "text-muted-foreground border-border-strong",
  BLOCKED: "text-warning border-warning/40",
  UNKNOWN: "text-muted-foreground border-border-strong",
};
const STATE_TEXT: Record<ReadyState, string> = { READY: "READY", NOT_CONFIGURED: "NOT CONFIGURED", BLOCKED: "BLOCKED", UNKNOWN: "UNKNOWN" };

function settingsText(templateId: string, settings: Record<string, string>) {
  const a = ADAPTERS[templateId];
  if (!a) return ["This template is not yet available as an MCP product."];
  return a.describeSettings(settings);
}

function useCreatorSession() {
  const [s, setS] = useState<"checking" | "signed_in" | "signed_out" | "unavailable">("checking");
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setS("unavailable");
        const b = (await r.json()) as { signedIn?: boolean; wallet?: string };
        if (b.signedIn && b.wallet) { setWallet(b.wallet); setS("signed_in"); } else setS("signed_out");
      })
      .catch(() => live && setS("unavailable"));
    return () => { live = false; };
  }, []);
  return { s, wallet };
}

function Launch() {
  const readiness = Route.useLoaderData();
  const w = useWallet();
  const session = useCreatorSession();
  const [input, setInput] = useState<DraftInput>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [review, setReview] = useState<{ draft: Draft; wallet: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const search = Route.useSearch();
  const param = useMemo(() => resolveTemplateParam(search.template), [search.template]);
  // Precedence: a restored draft or the user's own choice always wins; the URL only fills an untouched, empty form once.
  const urlApplied = useRef(false);
  const [toolNameTouched, setToolNameTouched] = useState(false);
  useEffect(() => {
    if (urlApplied.current || param.kind !== "launchable") return;
    urlApplied.current = true;
    setInput((p) => (p.templateId ? p : { ...p, templateId: param.id, settings: param.id === "whale-watch" ? { minLamports: WW_DEFAULT_THRESHOLD } : {}, ...(param.id === CANVAS_TEMPLATE_ID ? { canvas: EMPTY_CANVAS } : {}) }));
  }, [param]);
  const drafts = useDrafts(session.s === "signed_in" ? session.wallet : null);
  const [saved, setSaved] = useState<DraftView | null>(null);
  const savedJson = saved ? JSON.stringify(saved.input) : null;
  const dirty = savedJson !== JSON.stringify(input);
  const openDraft = (d: DraftView) => { urlApplied.current = true; setToolNameTouched(!!d.input.productName); setSaved(d); setInput(d.input); setErrors({}); setReview(null); setNotice(null); };
  const onSave = async () => {
    const r = validateDraft(input);
    if (!r.ok) { setErrors(r.errors); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    const out = await drafts.save(saved, input);
    if (out.draft) { setSaved(out.draft); setInput(out.draft.input); }
    if (out.fields) setErrors(out.fields);
  };
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const mainnetWallet = w.status === "connected_mainnet" && w.address ? w.address : null;

  // Wallet switch/disconnect invalidates a wallet-bound review. No builder call, no retry.
  useEffect(() => {
    if (review && review.wallet !== mainnetWallet) {
      setReview(null);
      setNotice(review.wallet ? "Your wallet changed or disconnected, so the reviewed draft was reopened for editing. Review it again." : null);
    }
  }, [mainnetWallet, review]);

  const set = <K extends keyof DraftInput>(k: K, v: DraftInput[K]) => {
    setInput((p) => ({ ...p, [k]: v }));
    setErrors((p) => ({ ...p, [k]: undefined }));
  };
  const setTokenName = (v: string) => {
    setInput((p) => ({ ...p, tokenName: v, productName: toolNameTouched ? p.productName : v.slice(0, LIMITS.productNameMax) }));
    setErrors((p) => ({ ...p, tokenName: undefined, productName: toolNameTouched ? p.productName : undefined }));
  };
  const pickTemplate = (id: string) => {
    setInput((p) => {
      const { canvas: _c, ...rest } = p;
      const next = { ...rest, templateId: id, settings: id === "whale-watch" ? { minLamports: WW_DEFAULT_THRESHOLD } : {} };
      return id === CANVAS_TEMPLATE_ID ? { ...next, canvas: p.canvas ?? EMPTY_CANVAS } : next;
    });
    setErrors((p) => ({ ...p, templateId: undefined, settings: undefined, canvas: undefined }));
  };

  const onReview = (e: React.FormEvent) => {
    e.preventDefault();
    const r = validateDraft(input);
    if (!r.ok) { setErrors(r.errors); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    setErrors({}); setNotice(null); setCopied("idle");
    setReview({ draft: r.draft, wallet: mainnetWallet });
    requestAnimationFrame(() => reviewRef.current?.focus());
  };

  const items: ReadinessItem[] = readiness?.items ?? [];
  const walletItem: ReadinessItem = {
    id: "wallet", label: "Creator wallet on Solana mainnet",
    state: mainnetWallet ? "READY" : w.status === "loading" ? "UNKNOWN" : "NOT_CONFIGURED",
    detail: mainnetWallet ? `Connected: ${shortAddress(mainnetWallet)}. Connecting does not create ownership.` : w.status === "connected_unsupported_network" ? "Connected, but not on Solana mainnet." : "No wallet connected.",
  };
  const errorCount = Object.values(errors).filter(Boolean).length;
  const summary = useMemo(() => review ? draftSummary(review.draft, settingsText(review.draft.templateId, review.draft.settings), review.wallet) : "", [review]);

  return (
    <>
      <PageHeader label="Builder" title="Launch preparation" intro="Draft and check a tool token. Token creation is unavailable — nothing on this page creates, signs or sends anything." />
      <PageContainer className="space-y-12 py-16">
        <StatusMessage tone="warning" title="Launch preparation — token creation unavailable">
          Required technical prerequisites are missing (listed below). You can prepare, save and review a draft. Saving a draft or publishing its metadata does not create, launch or own a token.
        </StatusMessage>

        <section aria-labelledby="readiness">
          <SectionHeading label="Prerequisites" title={<span id="readiness">What a real launch still needs</span>} />
          <ul className="mt-8 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {(readiness ? [...items.slice(0, 3), walletItem, ...items.slice(3)] : [walletItem]).map((it) => (
              <li key={it.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-foreground">{it.label}</p>
                  <p className="text-sm text-muted-foreground">{it.detail}</p>
                </div>
                <span className={`label-mono shrink-0 self-start rounded border px-2 py-1 sm:self-center ${STATE_STYLE[it.state]}`}>{STATE_TEXT[it.state]}</span>
              </li>
            ))}
            {!readiness && <li className="p-4 text-sm text-muted-foreground">Server prerequisites could not be checked right now (UNKNOWN). Your draft still works.</li>}
            <li className="p-4 text-sm text-muted-foreground">
              Creator sign-in: {session.s === "checking" ? "checking…" : session.s === "signed_in" ? `signed in as ${shortAddress(session.wallet ?? "")}` : session.s === "signed_out" ? "not signed in" : "could not be checked"}. Signing in does not create product ownership.
            </li>
          </ul>
          {readiness && <p className="mt-2 font-mono text-xs text-subtle">Checked {new Date(readiness.checkedAt).toUTCString()}</p>}
        </section>

        {notice && <StatusMessage tone="warning" title={notice} />}

        {session.s === "signed_in" && <SavedDrafts drafts={drafts} current={saved?.id ?? null} onOpen={openDraft} onNew={() => { setSaved(null); setInput(EMPTY); setReview(null); }} onAbandoned={(id) => { if (saved?.id === id) { setSaved(null); setInput(EMPTY); setReview(null); } }} />}

        {!review ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
          <form onSubmit={onReview} noValidate className="min-w-0 space-y-8" aria-labelledby="draft">
            <SectionHeading label="Draft" title={<span id="draft">Your tool token</span>} />
            {errorCount > 0 && (
              <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg border border-warning/40 bg-surface-2 p-4 text-sm text-foreground">
                {errorCount === 1 ? "1 field needs attention." : `${errorCount} fields need attention.`}
              </div>
            )}

            {param.kind === "unknown" && !saved && (
              <StatusMessage tone="warning" title="Template link not recognised">The link asked for a template that doesn't exist. Choose one of the templates below.</StatusMessage>
            )}
            {param.kind === "not_launchable" && !saved && (
              <StatusMessage tone="warning" title={`${param.name} can't be launched yet`}>This template is planned and has no working tool, so it can't be paired with a token. Choose an available template below.</StatusMessage>
            )}

            <section aria-labelledby="sec-token" className="space-y-6 rounded-lg border border-border p-5">
              <h3 id="sec-token" className="label-mono text-xs text-primary">1 · Token identity</h3>
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField id="tokenName" label="Token name" hint={`Up to ${LIMITS.tokenNameBytes} bytes. ${new TextEncoder().encode(input.tokenName).length}/${LIMITS.tokenNameBytes}`} value={input.tokenName} onChange={setTokenName} err={errors.tokenName} />
                <TextField id="symbol" label="Token symbol" hint="1–10 letters or numbers." value={input.symbol} onChange={(v) => set("symbol", v.toUpperCase())} err={errors.symbol} mono />
              </div>
              <label className="block text-sm">
                <span className="text-foreground">Description</span>
                <textarea id="description" rows={4} value={input.description} onChange={(e) => set("description", e.target.value)} aria-invalid={!!errors.description} aria-describedby="description-hint description-err" className="mt-1 block w-full rounded-md border border-border-strong bg-background p-2 text-foreground" />
                <span id="description-hint" className="mt-1 block text-xs text-subtle">Up to {LIMITS.descriptionBytes} bytes. {new TextEncoder().encode(input.description.trim()).length}/{LIMITS.descriptionBytes}</span>
                <FieldError id="description" msg={errors.description} />
              </label>
              <TextField id="link" label="Project link (optional)" hint="One https:// link. MCPX never opens or fetches it." value={input.link} onChange={(v) => set("link", v)} err={errors.link} />
            </section>

            <section aria-labelledby="sec-tool" className="space-y-5 rounded-lg border border-border p-5">
              <h3 id="sec-tool" className="label-mono text-xs text-primary">2 · MCP tool</h3>
              <ToolPreview id={input.templateId} />
              <fieldset aria-describedby="templateId-hint templateId-err">
                <legend className="text-sm text-foreground">{input.templateId ? "Change template" : "Template"}</legend>
                <div role="radiogroup" aria-label="Template" className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {TEMPLATES.map((t) => {
                    const lib = LIBRARY.find((x) => x.id === t.id);
                    const selected = input.templateId === t.id;
                    return (
                      <button key={t.id} type="button" role="radio" aria-checked={selected} onClick={() => pickTemplate(t.id)}
                        className={`group rounded-md border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? "border-primary bg-primary/10" : "border-border bg-card hover:border-border-strong"}`}>
                        <img src={lib?.image} alt="" width={1024} height={640} loading="lazy" className="aspect-[16/10] w-full rounded object-cover" />
                        <span className={`mt-2 block truncate text-xs font-medium ${selected ? "text-primary" : "text-foreground"}`}>{lib?.name ?? t.name}</span>
                        <span className="block font-mono text-[10px] text-subtle">{lib?.category}</span>
                      </button>
                    );
                  })}
                </div>
                <span id="templateId-hint" className="mt-2 block text-xs text-subtle">Only templates with a working tool are listed. Changing template resets its settings.</span>
                <FieldError id="templateId" msg={errors.templateId} />
              </fieldset>
              <TextField id="productName" label="Tool name" hint={toolNameTouched ? `Up to ${LIMITS.productNameMax} characters.` : `Follows the token name until you edit it. Up to ${LIMITS.productNameMax} characters.`} value={input.productName} onChange={(v) => { setToolNameTouched(true); set("productName", v); }} err={errors.productName} />
              <label className="block text-sm">
                <span className="text-foreground">Tool description (optional)</span>
                <textarea id="toolDescription" rows={2} value={input.toolDescription ?? ""} onChange={(e) => set("toolDescription", e.target.value)} aria-invalid={!!errors.toolDescription} aria-describedby="toolDescription-hint toolDescription-err" className="mt-1 block w-full rounded-md border border-border-strong bg-background p-2 text-foreground" />
                <span id="toolDescription-hint" className="mt-1 block text-xs text-subtle">One or two sentences about what your tool is for. Saved with the draft; not part of token metadata. {[...(input.toolDescription ?? "").trim()].length}/{LIMITS.toolDescriptionMax}</span>
                <FieldError id="toolDescription" msg={errors.toolDescription} />
              </label>
              {input.templateId === CANVAS_TEMPLATE_ID && (
                <CanvasBuilder value={input.canvas} onChange={(c) => set("canvas", c)} err={errors.canvas} signedIn={session.s === "signed_in"} />
              )}
              {input.templateId && input.templateId !== CANVAS_TEMPLATE_ID && (
                <div className="rounded-md border border-border bg-card p-4 text-sm">
                  <p className="text-foreground">Tool settings</p>
                  {templateSettingsMode(input.templateId) === "fixed" && input.templateId === "whale-watch" ? (
                    <label className="mt-3 block">
                      <span className="text-muted-foreground">Minimum transfer reported (fixed for every caller)</span>
                      <select className="mt-1 block w-full rounded-md border border-border-strong bg-background p-2 text-foreground" value={input.settings["minLamports"] ?? ""} onChange={(e) => set("settings", { minLamports: e.target.value })} aria-describedby="settings-err">
                        {WW_THRESHOLDS.map((t) => <option key={t.lamports} value={t.lamports}>{t.label}</option>)}
                      </select>
                    </label>
                  ) : (
                    <p className="mt-1 text-muted-foreground">{templateSettingsMode(input.templateId) === "none" ? "No configurable settings: every caller gets the same read." : "No product settings yet — this template isn't available as an MCP product today."}</p>
                  )}
                  <FieldError id="settings" msg={errors.settings} />
                </div>
              )}
            </section>

            <section aria-labelledby="sec-ai" className="rounded-lg border border-border p-5 text-sm">
              <h3 id="sec-ai" className="label-mono text-xs text-primary">3 · AI enhancement · optional</h3>
              <p className="mt-2 text-muted-foreground">Add your own API key to enhance your MCP tool, available in creator management. It's optional — your tool works without it, and the usage is billed to your own account.</p>
              <p className="mt-2 text-muted-foreground">Nothing here asks for a key. You add one later, when you're ready.</p>
            </section>

            <h3 className="label-mono text-xs text-primary">4 · Artwork, wallet and fees</h3>
            <ArtworkPanel signedIn={session.s === "signed_in"} saved={saved} dirty={dirty} drafts={drafts} onSaved={(d) => { setSaved(d); setReview(null); }} />

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">Creator wallet</p>
              <p className="mt-1 text-muted-foreground">{mainnetWallet ? <>Taken from your connected wallet: <span className="font-mono text-foreground">{mainnetWallet}</span></> : "Connect a wallet on Solana mainnet from the top bar to bind it to your review. It can't be typed in."}</p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">Child creator-fee sharing — <span className="text-muted-foreground">Design intent / not live</span></p>
              <ul className="mt-2 flex flex-wrap gap-4 font-mono text-muted-foreground">{FEE_SPLIT.map((f) => <li key={f.role}>{f.bps / 100}% {f.role}</li>)}</ul>
              <p className="mt-2 text-muted-foreground">Of actually collected child creator fees. Fixed by MCPX, not editable. Pair: CHILD / $MCP, subject to quote eligibility. Network fees and account rent (about 0.016 SOL in testing) will be shown before your wallet signs.</p>
            </div>

            <fieldset className="rounded-lg border border-border bg-card p-4 text-sm">
              <legend className="px-1 text-foreground">Initial buy (optional)</legend>
              <p className="text-muted-foreground">Separate purchase after verified creation; not part of creation transaction. This is a preference only — no buy happens and no price or order is promised. It would need your separate approval later.</p>
              <label className="mt-3 flex items-center gap-2 text-foreground">
                <input type="checkbox" checked={input.buyEnabled} onChange={(e) => set("buyEnabled", e.target.checked)} /> I'd like an initial buy later
              </label>
              {input.buyEnabled && (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <TextField id="buyAmount" label="Amount ($MCP)" hint="Positive, up to 9 decimals." value={input.buyAmount} onChange={(v) => set("buyAmount", v)} err={errors.buyAmount} mono inputMode="decimal" />
                  <TextField id="slippageBps" label="Max slippage (basis points)" hint="1–1000 (100 = 1%)." value={input.slippageBps} onChange={(v) => set("slippageBps", v)} err={errors.slippageBps} mono inputMode="numeric" />
                </div>
              )}
            </fieldset>

            <div className="flex flex-wrap gap-3">
              {session.s === "signed_in" && (
                <button type="button" className={buttonOutline} onClick={onSave} disabled={drafts.busy !== null || (!!saved && !dirty)}>
                  {drafts.busy === "save" ? "Saving…" : saved ? (dirty ? "Save changes" : "Saved") : "Save draft"}
                </button>
              )}
              <button type="submit" className={buttonPrimary}>Review draft</button>
              <Link to="/mcp" className={buttonOutline}>Browse templates</Link>
            </div>
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {session.s !== "signed_in" ? "Sign in as a creator from the Dashboard to save drafts and artwork. Without sign-in, your draft stays on this page only." : drafts.message ?? (saved ? (dirty ? `Unsaved changes (saved revision ${saved.revision}).` : `Saved — revision ${saved.revision}.`) : "Not saved yet.")}
            </p>
          </form>
          <DraftSummaryAside input={input} />
          </div>
        ) : (
          <section aria-labelledby="review" className="space-y-6">
            <h2 id="review" ref={reviewRef} tabIndex={-1} className="text-xl text-foreground">Draft review — preparation only</h2>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 font-mono text-sm text-muted-foreground">{summary}</pre>
            {saved && !dirty ? (
              <>
                <MetadataPanel saved={saved} drafts={drafts} onSaved={setSaved} />
                <LaunchTxCheck saved={saved} wallet={mainnetWallet} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{session.s === "signed_in" ? "Save this draft and its artwork to publish token metadata." : "This draft has not been sent anywhere."}</p>
            )}
            <p className="text-sm text-muted-foreground">Creating the token stays unavailable until every prerequisite above is proven. There is no Launch, Sign or Buy step.</p>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={buttonOutline} onClick={() => { setReview(null); setNotice(null); }}>Edit</button>
              <button type="button" className={buttonOutline} onClick={() => navigator.clipboard.writeText(summary).then(() => setCopied("ok"), () => setCopied("fail"))}>Copy draft summary</button>
              <span role="status" className="text-sm text-muted-foreground">{copied === "ok" ? "Copied." : copied === "fail" ? "Couldn't copy — select the text instead." : ""}</span>
            </div>
          </section>
        )}
      </PageContainer>
    </>
  );
}

function FieldError({ id, msg }: { id: string; msg?: string | undefined }) {
  return <span id={`${id}-err`} className="mt-1 block text-xs text-warning" aria-live="polite">{msg ?? ""}</span>;
}

function TextField(p: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void; err?: string | undefined; mono?: boolean; inputMode?: "decimal" | "numeric" }) {
  return (
    <label className="block text-sm">
      <span className="text-foreground">{p.label}</span>
      <input id={p.id} value={p.value} onChange={(e) => p.onChange(e.target.value)} inputMode={p.inputMode} aria-invalid={!!p.err} aria-describedby={`${p.id}-hint ${p.id}-err`} autoComplete="off" spellCheck={false}
        className={`mt-1 block w-full rounded-md border border-border-strong bg-background p-2 text-foreground ${p.mono ? "font-mono" : ""}`} />
      <span id={`${p.id}-hint`} className="mt-1 block text-xs text-subtle">{p.hint}</span>
      <FieldError id={p.id} msg={p.err} />
    </label>
  );
}

function ToolPreview({ id }: { id: string }) {
  const t = LIBRARY.find((x) => x.id === id);
  if (!t) return <p className="text-sm text-muted-foreground">No template selected yet.</p>;
  return (
    <div className="flex items-center gap-4 rounded-md border border-border bg-card p-3">
      <img src={t.image} alt="" width={1024} height={640} loading="lazy" className="h-14 w-24 shrink-0 rounded object-cover" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{t.name} <span className="ml-1 font-mono text-[11px] text-subtle">{t.category}</span></p>
        <p className="text-xs text-muted-foreground">{t.tagline} MCP: {t.mcpAdapter ? "adapter available" : "not available as an MCP product yet"}.</p>
      </div>
    </div>
  );
}

// Live, read-only summary. Sticky beside the form on wide screens; stacks after it on small screens.
function DraftSummaryAside({ input }: { input: DraftInput }) {
  const t = LIBRARY.find((x) => x.id === input.templateId);
  const row = (k: string, v: string) => (
    <div className="flex justify-between gap-3 py-1.5"><dt className="text-subtle">{k}</dt><dd className="min-w-0 truncate text-right text-foreground">{v}</dd></div>
  );
  return (
    <aside aria-label="Draft summary" className="rounded-lg border border-border bg-card p-5 text-sm lg:sticky lg:top-24">
      <p className="label-mono text-xs text-primary">Summary</p>
      {t && <img src={t.image} alt="" width={1024} height={640} loading="lazy" className="mt-3 aspect-[16/10] w-full rounded object-cover" />}
      <dl className="mt-3 divide-y divide-border font-mono text-xs">
        {row("Token", input.tokenName.trim() || "—")}
        {row("Symbol", input.symbol || "—")}
        {row("Tool", input.productName.trim() || "—")}
        {row("Template", t?.name ?? "not chosen")}
        {row("MCP", t ? (t.mcpAdapter ? "adapter available" : "not yet") : "—")}
        {row("Initial buy", input.buyEnabled ? `${input.buyAmount || "?"} $MCP` : "none")}
      </dl>
      <p className="mt-4 rounded border border-warning/40 p-2 text-xs text-muted-foreground">Draft only. Token creation is unavailable — nothing is created, signed or sent.</p>
    </aside>
  );
}
