import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, PageHeader, StatusMessage, SectionHeading, RouteError, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { LIBRARY, TEMPLATES, resolveTemplateParam } from "@/lib/templates";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
import { WW_THRESHOLDS, WW_DEFAULT_THRESHOLD } from "@/lib/tools/whale-watch";
import { useWallet } from "@/lib/wallet/context";
import { useCreatorSession } from "@/lib/creator-auth/use-creator-session";
import { FEE_SPLIT, LIMITS, draftSummary, templateSettingsMode, validateDraft, type Draft, type DraftInput, type FieldErrors } from "@/lib/launch/draft";
import { CAPABILITY_BY_ID } from "@/lib/canvas/catalog";
import { LaunchFlow } from "@/components/mcpx/launch/LaunchFlow";
import { CanvasBuilder, EMPTY_CANVAS } from "@/components/mcpx/launch/CanvasBuilder";
import { CANVAS_TEMPLATE_ID } from "@/lib/launch/draft";
import { ArtworkPicker, useDrafts, type DraftView } from "@/components/mcpx/launch/DraftPersistence";

export const Route = createFileRoute("/launch")({
  // ?template= is a hint only; it is resolved through resolveTemplateParam and never trusted as a draft field.
  validateSearch: (s: Record<string, unknown>): { template?: string } => (typeof s["template"] === "string" ? { template: s["template"] as string } : {}),
  head: () => ({
    meta: [
      { title: "Launch your token — MCPX" },
      { name: "description", content: "Choose your tools, configure your token and bring your own MCP-powered product to life on Solana. Configure, save and review your launch today." },
      { property: "og:title", content: "Launch your token — MCPX" },
      { property: "og:description", content: "Choose your tools, configure your token and bring your own MCP-powered product to life on Solana. " },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Launch,
  errorComponent: RouteError,
});

const EMPTY: DraftInput = { templateId: "", settings: {}, productName: "", toolDescription: "", tokenName: "", symbol: "", description: "", link: "", buyEnabled: false, buyAmount: "", slippageBps: "100" };

function settingsText(templateId: string, settings: Record<string, string>) {
  const a = ADAPTERS[templateId];
  if (!a) return ["This template is not yet available as an MCP product."];
  return a.describeSettings(settings);
}


function Launch() {
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
  const [art, setArt] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepErr, setPrepErr] = useState<string | null>(null);
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

  // Review quietly saves the launch (so the server only ever builds from saved details), uploads the
  // chosen artwork and prepares the token metadata. The creator never manages drafts.
  const onReview = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = validateDraft(input);
    if (!r.ok) { setErrors(r.errors); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    setErrors({}); setNotice(null); setCopied("idle"); setPrepErr(null);
    if (session.s === "signed_in") {
      setPreparing(true);
      try {
        let d = saved;
        if (!d || dirty) {
          const out = await drafts.save(d, input);
          if (out.fields) { setErrors(out.fields); return; }
          if (!out.draft) { setPrepErr(drafts.message ?? "We couldn't save your launch. Try again."); return; }
          d = out.draft; setSaved(d); setInput(d.input);
        }
        if (art) {
          const up = await drafts.upload(d, art, () => {});
          if (!up) { setPrepErr("Your artwork couldn't be saved. Try again."); return; }
          d = up; setSaved(d); setArt(null);
        }
        if (d.artwork && !d.metadata) {
          const m = await drafts.prepareMetadata(d);
          if (m) { d = m; setSaved(d); }
        }
      } finally { setPreparing(false); }
    }
    setReview({ draft: r.draft, wallet: mainnetWallet });
    requestAnimationFrame(() => reviewRef.current?.focus());
  };

  const errorCount = Object.values(errors).filter(Boolean).length;
  const summary = useMemo(() => review ? draftSummary(review.draft, settingsText(review.draft.templateId, review.draft.settings), review.wallet) : "", [review]);

  return (
    <>
      <PageHeader label="Launch" title="Launch your token. Power it with MCP." intro="Choose your tools, configure your token and bring your own MCP-powered product to life on Solana." className="py-8 sm:py-10" />
      <PageContainer className="space-y-6 py-8">


        {notice && <StatusMessage tone="warning" title={notice} />}


        {!review ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
          <form onSubmit={onReview} noValidate className="min-w-0 space-y-4" aria-labelledby="draft">
            <SectionHeading label="Launch" title={<span id="draft">Your tool token</span>} />
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

            <section aria-labelledby="sec-token" className="space-y-4 rounded-lg border border-border p-4">
              <h3 id="sec-token" className="label-mono text-xs text-primary">1 · Token identity</h3>
              <div className="grid gap-4 sm:grid-cols-2">
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

            <section aria-labelledby="sec-tool" className="space-y-4 rounded-lg border border-border p-4">
              <h3 id="sec-tool" className="label-mono text-xs text-primary">2 · MCP tool</h3>
              <ToolPreview id={input.templateId} />
              <fieldset aria-describedby="templateId-hint templateId-err">
                <legend className="text-sm text-foreground">{input.templateId ? "Change template" : "Template"}</legend>
                <div role="radiogroup" aria-label="Template" className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {TEMPLATES.filter((t) => !LIBRARY.find((x) => x.id === t.id)?.hidden).map((t) => {
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

            <h3 className="label-mono text-xs text-primary">3 · Artwork, wallet and fees</h3>
            <ArtworkPicker file={art} onFile={setArt} savedUrl={saved?.artwork?.url ?? null} />

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">Creator wallet</p>
              <p className="mt-1 text-muted-foreground">{mainnetWallet ? <>Taken from your connected wallet: <span className="font-mono text-foreground">{mainnetWallet}</span></> : "Connect a wallet on Solana mainnet from the top bar to bind it to your review. It can't be typed in."}</p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-foreground">Child creator-fee sharing</p>
              </div>

              <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-secondary" role="img" aria-label="Fee split: 60% creator, 25% tool operations, 15% platform">
                {FEE_SPLIT.map((f, i) => <span key={f.role} style={{ width: `${f.bps / 100}%` }} className={["bg-primary", "bg-primary/60", "bg-primary/35"][i]} />)}
              </div>

              <ul className="mt-1 divide-y divide-border">
                {FEE_SPLIT.map((f, i) => (
                  <li key={f.role} className="flex items-center gap-3 py-2">
                    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${["bg-primary", "bg-primary/60", "bg-primary/35"][i]}`} />
                    <span className="w-16 shrink-0 font-mono text-2xl font-semibold tabular-nums text-foreground">{f.bps / 100}%</span>
                    <span className="text-muted-foreground">{f.role}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-2 text-muted-foreground">Of actually collected child creator fees. Fixed by MCPX, not editable. Pair: CHILD / $MCP, subject to quote eligibility. Network fees and account rent (about 0.016 SOL in testing) will be shown before your wallet signs.</p>
            </div>

            <fieldset className="rounded-lg border border-border bg-card p-4 text-sm">
              <legend className="px-1 text-foreground">Initial buy (optional)</legend>
              <p className="text-muted-foreground">Bought in the same transaction as your token launch, right after the 60/25/15 fee split is locked. You approve it once in your wallet together with the launch. Price is not guaranteed; if the price moves past your slippage limit, the whole launch is cancelled and nothing is created.</p>
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
              <button type="submit" className={buttonPrimary} disabled={preparing}>{preparing ? "Preparing…" : "Review"}</button>
              <Link to="/mcp" className={buttonOutline}>Browse templates</Link>
            </div>
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {prepErr ?? (session.s !== "signed_in" ? (session.pending ?? session.note ?? "Verify your wallet to launch. You can still fill in and review the form.") : "")}
            </p>
            {session.s !== "signed_in" && session.s !== "checking" && (
              mainnetWallet
                ? <button type="button" className={buttonOutline} disabled={!!session.pending} onClick={() => void session.signIn()}>{session.pending ? "Check your wallet…" : "Verify Wallet"}</button>
                : <button type="button" className={buttonOutline} onClick={() => w.open?.()}>Connect Wallet</button>
            )}
          </form>
          <DraftSummaryAside input={input} />
          </div>
        ) : (
          <section aria-labelledby="review" className="space-y-4">
            <h2 id="review" ref={reviewRef} tabIndex={-1} className="text-xl text-foreground">Confirm your launch</h2>
            <p className="text-sm text-muted-foreground">Check the details below. When you press Launch, your wallet will ask you to sign the token creation.</p>
            <ReviewCard draft={review.draft} wallet={review.wallet} settings={settingsText(review.draft.templateId, review.draft.settings)} artworkUrl={saved?.artwork?.url ?? null} />
            <LaunchFlow saved={saved && !dirty ? saved : null} signedInWallet={session.s === "signed_in" ? session.wallet ?? null : null} connectedWallet={mainnetWallet} />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={buttonOutline} onClick={() => { setReview(null); setNotice(null); }}>Edit</button>
              <button type="button" className={buttonOutline} onClick={() => navigator.clipboard.writeText(summary).then(() => setCopied("ok"), () => setCopied("fail"))}>Copy summary</button>
              <span role="status" className="text-sm text-muted-foreground">{copied === "ok" ? "Copied." : copied === "fail" ? "Couldn't copy — select the text instead." : ""}</span>
            </div>
          </section>
        )}
      </PageContainer>
    </>
  );
}

// Friendly review of everything the creator is about to sign. Same facts as draftSummary (kept for
// the copy-to-clipboard text), presented as a card instead of a raw text dump.
function ReviewCard({ draft, wallet, settings, artworkUrl }: { draft: Draft; wallet: string | null; settings: string[]; artworkUrl: string | null }) {
  const t = LIBRARY.find((x) => x.id === draft.templateId);
  const row = (k: string, v: React.ReactNode, mono = false) => (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <dt className="shrink-0 text-sm text-subtle">{k}</dt>
      <dd className={`min-w-0 break-words text-right text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}>{v}</dd>
    </div>
  );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-4 border-b border-border bg-surface-2 p-4">
        {artworkUrl
          ? <img src={artworkUrl} alt="Token artwork" className="h-16 w-16 shrink-0 rounded-full border border-border object-cover" />
          : <span aria-hidden className="grid h-16 w-16 shrink-0 place-items-center rounded-full border border-border bg-background font-mono text-lg text-primary">{draft.symbol.slice(0, 2)}</span>}
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-foreground">{draft.tokenName} <span className="font-mono text-sm font-normal text-primary">${draft.symbol}</span></p>
          <p className="text-sm text-muted-foreground">{t ? `${t.name} template` : draft.templateName}{draft.link ? <> · <a href={draft.link} target="_blank" rel="noreferrer" className="text-primary underline">{draft.link.replace(/^https?:\/\//, "")}</a></> : null}</p>
        </div>
      </div>
      <dl className="divide-y divide-border">
        {row("Tool product", draft.productName)}
        {draft.toolDescription && row("Tool description", draft.toolDescription)}
        {row("Description", draft.description)}
        {settings.map((s, i) => row(i === 0 ? "How the tool runs" : "", s))}
        {draft.canvas && row("Canvas pipeline", draft.canvas.steps.map((s) => CAPABILITY_BY_ID[s.capabilityId]?.name ?? s.capabilityId).join(" → "))}
        {row("Creator wallet", wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : "Not connected", true)}
        <div className="px-4 py-2.5">
          <dt className="text-sm text-subtle">Fee split <span className="text-xs">(fixed by MCPX)</span></dt>
          <dd className="mt-2">
            <div aria-hidden className="flex h-2 overflow-hidden rounded-full">
              {FEE_SPLIT.map((f, i) => <span key={f.role} className={["bg-primary", "bg-primary/60", "bg-primary/35"][i]} style={{ width: `${f.bps / 100}%` }} />)}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {FEE_SPLIT.map((f, i) => (
                <li key={f.role} className="flex items-center gap-1.5">
                  <span aria-hidden className={`h-2 w-2 rounded-sm ${["bg-primary", "bg-primary/60", "bg-primary/35"][i]}`} />
                  <span className="font-mono text-foreground">{f.bps / 100}%</span> {f.role.toLowerCase()}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        {row("Initial buy", draft.initialBuy
          ? `${draft.initialBuy.amountMcp} $MCP (max ${draft.initialBuy.slippageBps / 100}% slippage) — bought in the same transaction as your token launch`
          : "None")}
      </dl>
    </div>
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
    <aside aria-label="Launch summary" className="rounded-lg border border-border bg-card p-4 text-sm lg:sticky lg:top-24">
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
          </aside>
  );
}
