// Saved launch drafts, artwork upload and metadata publishing (Phase 04-E). All calls go to same-origin
// creator routes with the session cookie; the wallet is never sent from the browser.
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import type { DraftInput, FieldErrors } from "@/lib/launch/draft";
import type { DraftView } from "@/lib/launch/drafts-core";
import { IMAGE_MAX_BYTES, checkImage } from "@/lib/launch/image";

export type { DraftView };
const H = { "content-type": "application/json", "x-mcpx-csrf": "1" };
const ERR: Record<string, string> = {
  stale_revision: "This draft changed in another tab or window. Reload it before saving again.",
  not_found: "This draft no longer exists.",
  too_many_drafts: "You have the maximum of 20 open drafts. Abandon one first.",
  storage_limit: "You've reached the artwork storage limit for your account.",
  artwork_required: "Add artwork before publishing metadata.",
  uri_too_long: "The metadata address would be too long for the token record.",
  rate_limited: "Too many requests. Wait a minute and try again.",
  unauthorized: "Your creator sign-in ended. Sign in again from the Dashboard.",
  too_large: "Artwork must be 5 MB or smaller.",
  unavailable: "The server couldn't save right now. Try again.",
};
const msgOf = (status: number, b: { error?: string; message?: string } | null) =>
  b?.message ?? ERR[b?.error ?? ""] ?? (status === 0 ? "Couldn't reach the server. Check your connection and try again." : "Something went wrong. Try again.");
const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");

export function useDrafts(wallet: string | null) {
  const [list, setList] = useState<DraftView[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState<null | "save" | "upload" | "metadata" | "abandon">(null);
  const [message, setMessage] = useState<string | null>(null);
  const createKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!wallet) { setList(null); return; }
    setState("loading");
    try {
      const r = await fetch("/api/creator/launch-drafts", { credentials: "same-origin" });
      if (!r.ok) { setState("error"); return; }
      setList(((await r.json()) as { drafts: DraftView[] }).drafts); setState("idle");
    } catch { setState("error"); }
  }, [wallet]);
  // Session change clears everything privileged before re-fetching for the new wallet.
  useEffect(() => { setList(null); setMessage(null); createKey.current = null; void load(); }, [load]);

  const post = async (body: unknown) => {
    try {
      const r = await fetch("/api/creator/launch-drafts", { method: "POST", credentials: "same-origin", headers: H, body: JSON.stringify(body) });
      const b = (await r.json().catch(() => null)) as { draft?: DraftView; error?: string; fields?: FieldErrors } | null;
      return { ok: r.ok, status: r.status, b };
    } catch { return { ok: false, status: 0, b: null }; }
  };

  const save = async (saved: DraftView | null, input: DraftInput): Promise<{ draft?: DraftView; fields?: FieldErrors }> => {
    setBusy("save"); setMessage(null);
    if (!saved && !createKey.current) createKey.current = newKey(); // reused on retry → no duplicate draft
    const r = await post(saved ? { action: "update", id: saved.id, revision: saved.revision, draft: input } : { action: "create", createKey: createKey.current, draft: input });
    setBusy(null);
    if (r.ok && r.b?.draft) { createKey.current = null; setMessage(`Saved — revision ${r.b.draft.revision}.`); void load(); return { draft: r.b.draft }; }
    setMessage(r.b?.error === "invalid_draft" ? "Some fields need attention." : msgOf(r.status, r.b));
    return r.b?.fields ? { fields: r.b.fields } : {};
  };

  const abandon = async (d: DraftView) => {
    setBusy("abandon");
    const r = await post({ action: "abandon", id: d.id, revision: d.revision });
    setBusy(null);
    setMessage(r.ok ? "Draft abandoned." : msgOf(r.status, r.b));
    void load();
    return r.ok;
  };

  const prepareMetadata = async (d: DraftView) => {
    setBusy("metadata"); setMessage(null);
    const r = await post({ action: "prepare_metadata", id: d.id, revision: d.revision });
    setBusy(null);
    if (r.ok && r.b?.draft) { void load(); return r.b.draft; }
    setMessage(msgOf(r.status, r.b));
    return null;
  };

  const upload = (d: DraftView, file: File, onProgress: (p: number) => void) => new Promise<DraftView | null>((resolve) => {
    setBusy("upload"); setMessage(null);
    const x = new XMLHttpRequest();
    x.open("POST", `/api/creator/launch-artwork?draft=${d.id}&revision=${d.revision}`);
    x.withCredentials = true;
    x.setRequestHeader("content-type", file.type);
    x.setRequestHeader("x-mcpx-csrf", "1");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      setBusy(null);
      let b: { draft?: DraftView; error?: string; message?: string } | null = null;
      try { b = JSON.parse(x.responseText); } catch { /* unreadable */ }
      if (x.status === 200 && b?.draft) { void load(); setMessage("Artwork saved."); resolve(b.draft); } else { setMessage(msgOf(x.status, b)); resolve(null); }
    };
    x.onerror = () => { setBusy(null); setMessage(msgOf(0, null)); resolve(null); };
    x.send(file);
  });

  return { list, state, busy, message, setMessage, load, save, abandon, prepareMetadata, upload };
}
export type Drafts = ReturnType<typeof useDrafts>;

export function SavedDrafts({ drafts, current, onOpen, onNew, onAbandoned }: { drafts: Drafts; current: string | null; onOpen: (d: DraftView) => void; onNew: () => void; onAbandoned: (id: string) => void }) {
  return (
    <section aria-labelledby="saved-drafts" className="rounded-lg border border-border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="saved-drafts" className="text-foreground">Your saved drafts</h2>
        <button type="button" className={buttonOutline} onClick={onNew}>New draft</button>
      </div>
      {drafts.state === "loading" && !drafts.list && <p className="mt-2 text-muted-foreground">Loading your drafts…</p>}
      {drafts.state === "error" && <p className="mt-2 text-warning">Couldn't load your drafts. <button type="button" className="underline" onClick={() => void drafts.load()}>Try again</button></p>}
      {drafts.list && drafts.list.length === 0 && <p className="mt-2 text-muted-foreground">No saved drafts yet.</p>}
      {drafts.list && drafts.list.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {drafts.list.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-foreground">{d.input.productName} <span className="font-mono text-muted-foreground">({d.input.symbol})</span>{current === d.id && <span className="ml-2 text-xs text-primary">open</span>}</p>
                <p className="text-xs text-muted-foreground">{STATUS_TEXT[d.status]} · revision {d.revision} · on chain: not started · updated {new Date(d.updatedAt).toUTCString()}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className={buttonOutline} onClick={() => onOpen(d)}>Open</button>
                <button type="button" className={buttonOutline} disabled={drafts.busy !== null} onClick={async () => { if (window.confirm("Abandon this draft? It will no longer be listed.") && (await drafts.abandon(d))) onAbandoned(d.id); }}>Abandon</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_TEXT: Record<string, string> = {
  DRAFT: "Draft", ARTWORK_SAVED: "Artwork saved", METADATA_VALIDATED: "Metadata checked",
  READY_FOR_FUTURE_PREPARATION: "Off-chain checks passed (not a launch)", ABANDONED: "Abandoned",
};

/** Browser decode on top of the shared structural check; the server repeats the structural check. */
async function checkFile(f: File): Promise<string | null> {
  if (f.size > IMAGE_MAX_BYTES) return "Artwork must be 5 MB or smaller (5,000,000 bytes).";
  const bytes = new Uint8Array(await f.arrayBuffer());
  const c = await checkImage(bytes);
  if (!c.ok) return c.error;
  if (f.type && f.type !== c.type) return "The file's contents don't match its type.";
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: c.type }));
    const okSize = bmp.width === c.width && bmp.height === c.height;
    bmp.close();
    if (!okSize) return "The image is inconsistent and can't be used.";
  } catch { return "The image couldn't be decoded."; }
  return null;
}

export function ArtworkPanel({ signedIn, saved, dirty, drafts, onSaved }: { signedIn: boolean; saved: DraftView | null; dirty: boolean; drafts: Drafts; onSaved: (d: DraftView) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = async (f: File | undefined) => {
    setErr(null); setProgress(null);
    if (!f) return;
    const problem = await checkFile(f);
    if (problem) { setErr(problem); setFile(null); setPreview(null); return; }
    setFile(f); setPreview(URL.createObjectURL(f));
  };
  const clear = () => { setFile(null); setPreview(null); setErr(null); setProgress(null); if (inputRef.current) inputRef.current.value = ""; };
  const upload = async () => {
    if (!file || !saved) return;
    const d = await drafts.upload(saved, file, setProgress);
    if (d) { onSaved(d); clear(); } else setProgress(null);
  };
  const canUpload = signedIn && saved && !dirty;

  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm">
      <p className="text-foreground">Token artwork</p>
      <p className="mt-1 text-muted-foreground">Square (1:1) PNG or JPEG, 5 MB maximum. Not cropped or resized.</p>
      {saved?.artwork && (
        <div className="mt-3 flex items-center gap-3">
          <img src={saved.artwork.url} alt="Saved token artwork" width={64} height={64} className="h-16 w-16 rounded border border-border object-cover" />
          <p className="text-muted-foreground">Saved: {saved.artwork.width}×{saved.artwork.height}, {(saved.artwork.bytes / 1e6).toFixed(2)} MB. <a className="underline" href={saved.artwork.url} target="_blank" rel="noreferrer">Open</a></p>
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files[0]); }}
        className={`mt-3 rounded-md border border-dashed p-4 ${over ? "border-primary" : "border-border-strong"}`}
      >
        <label className="block">
          <span className="text-foreground">{saved?.artwork ? "Replace artwork" : "Choose artwork"}</span>
          <span className="block text-xs text-subtle">or drag an image here</span>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg" className="mt-2 block w-full text-muted-foreground" aria-describedby="artwork-err" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {preview && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <img src={preview} alt="Selected artwork preview (not saved yet)" className="h-24 w-24 rounded border border-border object-cover" />
            <div className="space-y-2">
              <p className="text-muted-foreground">Preview only — not saved yet.</p>
              <div className="flex gap-2">
                <button type="button" className={buttonPrimary} disabled={!canUpload || drafts.busy !== null} onClick={upload}>{drafts.busy === "upload" ? `Uploading… ${progress ?? 0}%` : "Save artwork"}</button>
                <button type="button" className={buttonOutline} onClick={clear}>Remove</button>
              </div>
            </div>
          </div>
        )}
        <span id="artwork-err" role="alert" className="mt-2 block text-xs text-warning">{err ?? ""}</span>
        {!signedIn && <p className="text-xs text-subtle">Sign in as a creator to save artwork.</p>}
        {signedIn && (!saved || dirty) && <p className="text-xs text-subtle">Save the draft first, then save artwork to it.</p>}
      </div>
    </div>
  );
}

export function MetadataPanel({ saved, drafts, onSaved }: { saved: DraftView; drafts: Drafts; onSaved: (d: DraftView) => void }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-sm">
      <p className="text-foreground">Token metadata</p>
      {saved.metadata ? (
        <div className="mt-2 space-y-1 text-muted-foreground">
          <p>Published for revision {saved.revision}. These addresses are public and never change:</p>
          <p className="break-all font-mono text-xs">Metadata: <a className="underline" href={saved.metadata.url} target="_blank" rel="noreferrer">{saved.metadata.url}</a></p>
          {saved.artwork && <p className="break-all font-mono text-xs">Image: <a className="underline" href={saved.artwork.url} target="_blank" rel="noreferrer">{saved.artwork.url}</a></p>}
          <p>Off-chain checks passed. This is not a token: nothing was created, signed or sent. Editing the draft makes new metadata necessary.</p>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">{saved.artwork ? "Publish the token metadata (name, symbol, description, image, link) for this exact saved revision." : "Save artwork first."}</p>
          <button type="button" className={buttonPrimary} disabled={!saved.artwork || drafts.busy !== null} onClick={async () => { const d = await drafts.prepareMetadata(saved); if (d) onSaved(d); }}>
            {drafts.busy === "metadata" ? "Publishing…" : "Publish metadata"}
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">{drafts.message ?? ""}</p>
    </div>
  );
}
