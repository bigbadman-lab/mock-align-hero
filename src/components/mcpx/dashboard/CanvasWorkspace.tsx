// Creator-dashboard Canvas workspace: edit the pipeline of a launched Canvas product. Only the verified
// creator sees it; every save is re-validated server-side and appended as a new immutable version.
import { useEffect, useState } from "react";
import { CanvasBuilder } from "@/components/mcpx/launch/CanvasBuilder";
import { FeatureAvailability, buttonOutline } from "@/components/mcpx/primitives";
import { validateCanvas, type CanvasConfig } from "@/lib/canvas/validate";

type Product = { creationId: string; slug: string; name: string; childMint: string; version: number | null; config: CanvasConfig | null; updatedAt: string | null };
type State = { k: "loading" } | { k: "signed_out" } | { k: "unavailable"; msg: string } | { k: "ready"; products: Product[] };

export function CanvasWorkspace() {
  const [st, setSt] = useState<State>({ k: "loading" });
  const load = async () => {
    try {
      const r = await fetch("/api/creator/canvas", { credentials: "same-origin" });
      if (r.status === 401) return setSt({ k: "signed_out" });
      const b = (await r.json().catch(() => null)) as { available?: boolean; products?: Product[] } | null;
      if (!r.ok || !b) return setSt({ k: "unavailable", msg: "Canvas workspace is unavailable right now." });
      if (!b.available) return setSt({ k: "unavailable", msg: "Canvas products appear here once a Canvas token has launched and been verified. Not available yet." });
      setSt({ k: "ready", products: b.products ?? [] });
    } catch { setSt({ k: "unavailable", msg: "Network error. Reload to try again." }); }
  };
  useEffect(() => { void load(); }, []);

  return (
    <section aria-labelledby="d-canvas" className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="d-canvas" className="text-sm font-semibold">Canvas workspace</h2>
        <FeatureAvailability>Creator only</FeatureAvailability>
      </div>
      {st.k === "loading" && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}
      {st.k === "signed_out" && <p className="mt-3 text-sm text-muted-foreground">Sign in as a creator above to edit your Canvas products.</p>}
      {st.k === "unavailable" && <p className="mt-3 text-sm text-muted-foreground">{st.msg}</p>}
      {st.k === "ready" && (st.products.length === 0
        ? <p className="mt-3 text-sm text-muted-foreground">You have no launched Canvas products yet. Build a Canvas pipeline in a launch draft first.</p>
        : <div className="mt-4 space-y-6">{st.products.map((p) => <ProductEditor key={p.creationId} p={p} onSaved={load} />)}</div>)}
    </section>
  );
}

function ProductEditor({ p, onSaved }: { p: Product; onSaved: () => void }) {
  const [cfg, setCfg] = useState<CanvasConfig | null>(p.config);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = cfg ? validateCanvas(cfg).ok : false;
  const save = async () => {
    if (!cfg || !p.version) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/creator/canvas", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" },
        body: JSON.stringify({ creationId: p.creationId, expectedVersion: p.version, canvas: cfg }) });
      const b = (await r.json().catch(() => null)) as { version?: number; error?: string } | null;
      if (r.ok && b?.version) { setMsg(`Saved as version ${b.version}.`); onSaved(); }
      else setMsg(b?.error === "stale_version" ? "This Canvas changed elsewhere. Reload to edit the latest version." : b?.error === "invalid" ? "This pipeline isn't valid." : "Couldn't save right now.");
    } catch { setMsg("Network error. Try again."); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-md border border-border-strong p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-foreground">{p.name}</span>
        <span className="font-mono text-xs text-subtle">{p.version ? `version ${p.version}` : "not linked yet"}</span>
      </div>
      {!p.version ? <p className="text-xs text-muted-foreground">This product's Canvas links automatically once its launch is verified on-chain.</p> : (
        <>
          <CanvasBuilder value={cfg} onChange={setCfg} signedIn creationId={p.creationId} />
          <button type="button" className={buttonOutline} onClick={save} disabled={!ok || busy}>{busy ? "Saving…" : "Save new version"}</button>
          {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
        </>
      )}
    </div>
  );
}
