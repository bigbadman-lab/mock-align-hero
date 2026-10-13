// Creator-only OpenAI key (BYOK) panel for ONE verified product. The server re-checks wallet session + product
// ownership on every call. The key field is write-only: after saving, nothing of the key is ever shown again.
// When the operator hasn't switched BYOK on, this renders honest informational text only (no inert buttons).
import { useEffect, useRef, useState } from "react";
import { buttonOutline, buttonPrimary } from "./primitives";

type Limits = { maxConcurrency: number; maxPerMinute: number; maxPerDay: number; maxInputTokens: number; maxOutputTokens: number };
type Integration = { provider: string; model: string; status: string; enabled: boolean; revision: number; hasKey: boolean; limits: Limits; health: string; healthCheckedAt: string | null };
type State = "not_connected" | "unchecked" | "paused" | "active" | "held" | "provider_error" | "revoked";
type Usage = { today: { requests: number; failed: number; ambiguous: number }; inFlight: number };

const MODELS = ["gpt-4o-mini", "gpt-4.1-mini"] as const;
// Mirrors server ceilings (src/lib/byok/providers.ts); the server is authoritative.
const CEIL: Record<keyof Limits, { min: number; max: number; label: string }> = {
  maxConcurrency: { min: 1, max: 4, label: "Calls at once" },
  maxPerMinute: { min: 1, max: 30, label: "Calls per minute" },
  maxPerDay: { min: 1, max: 2000, label: "Calls per UTC day" },
  maxInputTokens: { min: 256, max: 8000, label: "Max input tokens" },
  maxOutputTokens: { min: 64, max: 1024, label: "Max output tokens" },
};
const STATE_TEXT: Record<State, string> = {
  not_connected: "Not connected",
  unchecked: "Key saved — not checked yet",
  paused: "Paused",
  active: "Active",
  held: "On hold — the OpenAI account has no remaining credit",
  provider_error: "OpenAI couldn't confirm the key right now",
  revoked: "Removed",
};
const HEALTH_TEXT: Record<string, string> = {
  ok: "OpenAI accepted the key for this model.",
  invalid_key: "OpenAI rejected this key. AI was paused automatically; the key was not deleted. Replace it to continue.",
  no_permission: "OpenAI refused access (permissions, project or region). This doesn't prove the key is wrong.",
  no_credit: "The OpenAI account has no remaining credit or quota. Add credit at OpenAI, then check again.",
  rate_limited: "OpenAI is rate-limiting this key. Try again in a few minutes.",
  model_unavailable: "This key can't use the selected model. Pick another model or check your OpenAI project.",
  provider_error: "OpenAI didn't answer in time or returned an error. Nothing was changed; try again later.",
};
const ERR_TEXT: Record<string, string> = {
  rate_limited: "Too many requests. Wait a minute and try again.",
  stale_revision: "Settings changed elsewhere. Reloaded the latest state — review and try again.",
  revoked: "This key was removed. Connect a new key to start again.",
  needs_passing_test: "Run a successful connection check on the current key before resuming.",
  unsupported_model: "That model isn't allowed.",
  invalid_input: "Check the fields and try again. OpenAI keys start with “sk-”.",
  not_found: "You are not authorized to manage this product.",
  byok_not_enabled: "AI keys are temporarily stopped by MCPX. Nothing was changed; try again later.",
};
const newIdem = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32);
const field = "w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

export function ProductAiKey({ creationId, onSessionEnded }: { creationId: string; onSessionEnded: () => void }) {
  const [avail, setAvail] = useState<"loading" | "available" | "off" | "error">("loading");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ integration: Integration | null; state: State } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [model, setModel] = useState<string>(MODELS[0]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const idem = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/creator/ai", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b: { available: boolean }) => { if (live) setAvail(b.available ? "available" : "off"); })
      .catch(() => { if (live) setAvail("error"); });
    return () => { live = false; };
  }, []);

  async function call(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setNote(null);
    try {
      const r = await fetch("/api/creator/ai", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" },
        body: JSON.stringify({ action, creationId, provider: null, apiKey: null, model: null, idempotencyKey: null, expectedRevision: null, enabled: null, limits: null, ...extra }),
      });
      if (r.status === 401) { onSessionEnded(); return null; }
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        const e = String(b["error"] ?? "");
        setNote(ERR_TEXT[e] ?? "Couldn't complete that right now. Nothing changed that we know of — reload to check.");
        if (e === "stale_revision") await refresh(false);
        return null;
      }
      return b;
    } catch { setNote("Network error. Reload to check the current state."); return null; }
    finally { setBusy(false); }
  }
  function apply(b: Record<string, unknown>) {
    if (!("state" in b)) return;
    const integration = (b["integration"] as Integration | null) ?? null;
    setData({ integration, state: b["state"] as State });
    if (integration) { setModel(integration.model); setLimits(integration.limits); }
  }
  async function refresh(clear = true) {
    const b = await call("get_status");
    if (b) apply(b);
    const u = await call("get_usage");
    if (u) setUsage(u["usage"] as Usage);
    if (clear && b) setNote(null);
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    const input = keyRef.current;
    const apiKey = input?.value.trim() ?? "";
    if (!/^sk-[A-Za-z0-9_-]{20,200}$/.test(apiKey)) { setNote(ERR_TEXT["invalid_input"]!); return; }
    const i = data?.integration;
    const replacing = !!i && i.status !== "revoked" && i.hasKey;
    if (replacing && !window.confirm("Replace the saved key? The old key is erased and AI stays paused until the new key passes a check.")) return;
    idem.current ??= newIdem();
    const b = await call(replacing ? "rotate" : "connect_or_replace", {
      provider: "openai", apiKey, model, idempotencyKey: idem.current, expectedRevision: i && i.status !== "revoked" ? i.revision : 1,
    });
    if (!b) return; // keep the typed key so a retry reuses the same idempotency key
    if (input) input.value = "";
    idem.current = null;
    apply(b);
    setNote(b["result"] === "replayed" ? "That key was already saved." : "Key saved and encrypted. Run a connection check next.");
  }
  async function check() {
    if (!window.confirm("Check this key with OpenAI? This sends one tiny request (1 output token), which OpenAI may bill to your account.")) return;
    const b = await call("test_connection");
    if (!b) return;
    apply(b);
    setNote(HEALTH_TEXT[String(b["health"])] ?? null);
  }
  async function setEnabled(enabled: boolean) {
    const i = data?.integration; if (!i) return;
    const b = await call("set_enabled", { enabled, expectedRevision: i.revision });
    if (b) { await refresh(false); setNote(enabled ? "AI resumed for this product." : "AI paused. Calls already running finish and are still counted."); }
  }
  async function saveSettings() {
    const i = data?.integration; if (!i || !limits) return;
    const b = await call("set_model_and_limits", { model, limits, expectedRevision: i.revision });
    if (b) { await refresh(false); setNote(model !== i.model ? "Saved. The model changed, so run a new connection check." : "Limits saved."); }
  }
  async function revoke() {
    const i = data?.integration; if (!i) return;
    if (!window.confirm("Remove this key? It's erased permanently and AI stops for this product. This can't be undone.")) return;
    const b = await call("revoke_and_remove", { expectedRevision: i.revision });
    if (b) { await refresh(false); setNote("Key removed and erased."); }
  }

  if (avail === "loading") return <p className="text-sm">Checking AI key setup…</p>;
  if (avail === "error") return <p className="text-sm">Couldn't check whether AI key setup is available. Reload to try again.</p>;
  if (avail === "off") return (
    <div className="rounded-md border border-border p-3 text-sm">
      <p className="text-foreground">Your own OpenAI key (optional)</p>
      <p>Temporarily unavailable (MCPX maintenance stop). Your saved settings are unchanged and AI calls are paused until it's lifted.</p>
    </div>
  );

  const i = data?.integration ?? null;
  const st = data?.state ?? "not_connected";
  const live = i && i.status !== "revoked";
  return (
    <section aria-label="Your own OpenAI key" className="space-y-3 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-foreground">Your own OpenAI key (optional)</p>
        <button type="button" disabled={busy} onClick={() => { setOpen(true); void refresh(); }} className={buttonOutline}>{open ? "Reload" : "Manage AI key"}</button>
      </div>
      {note && <p role="status" className="text-foreground">{note}</p>}
      {open && data && (
        <div className="space-y-4">
          <p>Status: <span className="font-mono text-foreground">{STATE_TEXT[st]}</span>
            {i?.healthCheckedAt ? <> · last checked {new Date(i.healthCheckedAt).toLocaleString()}</> : null}</p>
          {i && i.health !== "unchecked" && st !== "active" && HEALTH_TEXT[i.health] && <p>{HEALTH_TEXT[i.health]}</p>}

          <form onSubmit={(e) => void saveKey(e)} autoComplete="off" className="space-y-2" data-lpignore="true">
            <label className="block space-y-1">
              <span className="text-foreground">{live && i?.hasKey ? "Replace key" : "OpenAI API key"}</span>
              <input ref={keyRef} type="password" name={`byok-${creationId}`} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off"
                inputMode="text" maxLength={210} placeholder="sk-…" className={field} disabled={busy} aria-describedby={`byok-help-${creationId}`} />
            </label>
            <p id={`byok-help-${creationId}`} className="text-xs">Encrypted on MCPX's server. It's never shown again — not even partly. MCPX only uses it for this product.</p>
            <label className="block space-y-1">
              <span className="text-foreground">Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)} className={field} disabled={busy}>
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy} className={buttonPrimary}>{live && i?.hasKey ? "Replace key" : "Save key"}</button>
          </form>

          {live && i?.hasKey && (
            <>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void check()} className={buttonOutline}>Check connection</button>
                {i.enabled
                  ? <button type="button" disabled={busy} onClick={() => void setEnabled(false)} className={buttonOutline}>Pause AI</button>
                  : <button type="button" disabled={busy || st === "unchecked"} onClick={() => void setEnabled(true)} className={buttonOutline}>Resume AI</button>}
                <button type="button" disabled={busy} onClick={() => void revoke()} className={buttonOutline}>Remove key</button>
              </div>
              {!i.enabled && st === "unchecked" && <p className="text-xs">Resume becomes available after a successful connection check.</p>}
              <p className="text-xs">When AI is Active, your product's MCP tool offers an optional AI summary (ai_summary) that uses this key and these limits. Without a key, the tool still works normally.</p>

              {limits && (
                <fieldset className="space-y-2">
                  <legend className="text-foreground">Usage limits (enforced on MCPX's server)</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(Object.keys(CEIL) as (keyof Limits)[]).map((k) => (
                      <label key={k} className="block space-y-1">
                        <span>{CEIL[k].label} <span className="text-xs">({CEIL[k].min}–{CEIL[k].max})</span></span>
                        <input type="number" min={CEIL[k].min} max={CEIL[k].max} step={1} value={limits[k]} disabled={busy} className={field}
                          onChange={(e) => setLimits({ ...limits, [k]: Math.trunc(Number(e.target.value)) })} />
                      </label>
                    ))}
                  </div>
                  <button type="button" disabled={busy} onClick={() => void saveSettings()} className={buttonOutline}>Save model and limits</button>
                </fieldset>
              )}

              {usage && (
                <p className="text-xs">Today (UTC, resets 00:00 UTC): {usage.today.requests} calls · {usage.today.failed} failed · {usage.today.ambiguous} unconfirmed (counted as fully used) · {usage.inFlight} running</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
