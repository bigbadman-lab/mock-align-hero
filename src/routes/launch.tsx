import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, PageHeader, StatusMessage, SectionHeading, RouteError, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { TEMPLATES } from "@/lib/templates";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
import { WW_THRESHOLDS, WW_DEFAULT_THRESHOLD } from "@/lib/tools/whale-watch";
import { useWallet } from "@/lib/wallet/context";
import { shortAddress } from "@/lib/wallet/state";
import { FEE_SPLIT, LIMITS, draftSummary, templateSettingsMode, validateDraft, type Draft, type DraftInput, type FieldErrors } from "@/lib/launch/draft";
import type { ReadinessItem, ReadyState } from "@/lib/launch/readiness";
import { getLaunchReadiness } from "@/lib/launch/readiness.functions";
import { ArtworkPanel, MetadataPanel, SavedDrafts, useDrafts, type DraftView } from "@/components/mcpx/launch/DraftPersistence";

export const Route = createFileRoute("/launch")({
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

const EMPTY: DraftInput = { templateId: "", settings: {}, productName: "", tokenName: "", symbol: "", description: "", link: "", buyEnabled: false, buyAmount: "", slippageBps: "100" };
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
  const drafts = useDrafts(session.s === "signed_in" ? session.wallet : null);
  const [saved, setSaved] = useState<DraftView | null>(null);
  const savedJson = saved ? JSON.stringify(saved.input) : null;
  const dirty = savedJson !== JSON.stringify(input);
  const openDraft = (d: DraftView) => { setSaved(d); setInput(d.input); setErrors({}); setReview(null); setNotice(null); };
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
  const pickTemplate = (id: string) => {
    setInput((p) => ({ ...p, templateId: id, settings: id === "whale-watch" ? { minLamports: WW_DEFAULT_THRESHOLD } : {} }));
    setErrors((p) => ({ ...p, templateId: undefined, settings: undefined }));
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
          <form onSubmit={onReview} noValidate className="space-y-8" aria-labelledby="draft">
            <SectionHeading label="Draft" title={<span id="draft">Your tool token</span>} />
            {errorCount > 0 && (
              <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg border border-warning/40 bg-surface-2 p-4 text-sm text-foreground">
                {errorCount === 1 ? "1 field needs attention." : `${errorCount} fields need attention.`}
              </div>
            )}

            <fieldset>
              <legend className="text-sm font-medium text-foreground">Template</legend>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {TEMPLATES.map((t) => (
                  <label key={t.id} className={`cursor-pointer rounded-lg border p-4 text-sm focus-within:ring-2 focus-within:ring-ring ${input.templateId === t.id ? "border-primary bg-surface-2" : "border-border bg-card"}`}>
                    <input type="radio" name="template" value={t.id} checked={input.templateId === t.id} onChange={() => pickTemplate(t.id)} className="sr-only" />
                    <span className="block text-foreground">{t.name}</span>
                    <span className="mt-1 block text-muted-foreground">{t.purpose}</span>
                  </label>
                ))}
              </div>
              <FieldError id="templateId" msg={errors.templateId} />
            </fieldset>

            {input.templateId && (
              <div className="rounded-lg border border-border bg-card p-4 text-sm">
                <p className="text-foreground">Template settings</p>
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

            <div className="grid gap-6 sm:grid-cols-2">
              <TextField id="productName" label="Product name" hint={`Up to ${LIMITS.productNameMax} characters.`} value={input.productName} onChange={(v) => set("productName", v)} err={errors.productName} />
              <TextField id="tokenName" label="Token name" hint={`Up to ${LIMITS.tokenNameBytes} bytes. ${new TextEncoder().encode(input.tokenName).length}/${LIMITS.tokenNameBytes}`} value={input.tokenName} onChange={(v) => set("tokenName", v)} err={errors.tokenName} />
              <TextField id="symbol" label="Token symbol" hint="1–10 letters or numbers." value={input.symbol} onChange={(v) => set("symbol", v.toUpperCase())} err={errors.symbol} mono />
              <TextField id="link" label="Project link (optional)" hint="One https:// link. MCPX never opens or fetches it." value={input.link} onChange={(v) => set("link", v)} err={errors.link} />
            </div>
            <label className="block text-sm">
              <span className="text-foreground">Description</span>
              <textarea id="description" rows={4} value={input.description} onChange={(e) => set("description", e.target.value)} aria-invalid={!!errors.description} aria-describedby="description-hint description-err" className="mt-1 block w-full rounded-md border border-border-strong bg-background p-2 text-foreground" />
              <span id="description-hint" className="mt-1 block text-xs text-subtle">Up to {LIMITS.descriptionBytes} bytes. {new TextEncoder().encode(input.description.trim()).length}/{LIMITS.descriptionBytes}</span>
              <FieldError id="description" msg={errors.description} />
            </label>

            <ArtworkPanel signedIn={session.s === "signed_in"} saved={saved} dirty={dirty} drafts={drafts} onSaved={(d) => { setSaved(d); setReview(null); }} />

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">Creator wallet</p>
              <p className="mt-1 text-muted-foreground">{mainnetWallet ? <>Taken from your connected wallet: <span className="font-mono text-foreground">{mainnetWallet}</span></> : "Connect a wallet on Solana mainnet from the top bar to bind it to your review. It can't be typed in."}</p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">Fee split (fixed by MCPX, not editable)</p>
              <ul className="mt-2 flex flex-wrap gap-4 font-mono text-muted-foreground">{FEE_SPLIT.map((f) => <li key={f.role}>{f.bps / 100}% {f.role.toLowerCase()}</li>)}</ul>
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
        ) : (
          <section aria-labelledby="review" className="space-y-6">
            <h2 id="review" ref={reviewRef} tabIndex={-1} className="text-xl text-foreground">Draft review — preparation only</h2>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 font-mono text-sm text-muted-foreground">{summary}</pre>
            {saved && !dirty ? (
              <MetadataPanel saved={saved} drafts={drafts} onSaved={setSaved} />
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
