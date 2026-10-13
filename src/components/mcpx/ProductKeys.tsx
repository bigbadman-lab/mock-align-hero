// Creator key management for ONE product. Every action goes to the protected server route, which re-checks
// the session wallet against the verified creator on each request. Plaintext keys live only in component
// state for the current view and are never stored, logged or put in a URL.
import { useState } from "react";
import { buttonOutline } from "./primitives";
import { CopyButton } from "./McpConnection";
import { ProductAiKey } from "./ProductAiKey";

type KeyMeta = { keyId: string; prefix: string; status: string; label: string | null; createdAt: string; expiresAt: string | null; revokedAt: string | null };
const post = (body: unknown) =>
  fetch("/api/creator/products", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify(body) });
const newIdem = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32);

export function ProductKeys({ creationId, displayName, onSessionEnded }: { creationId: string; displayName: string; onSessionEnded: () => void }) {
  const [keys, setKeys] = useState<KeyMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  // One idempotency key per intended action; reused on retry, so a retried issue can't create a second key.
  const [pendingIdem, setPendingIdem] = useState<{ action: string; keyId: string | null; idem: string } | null>(null);

  async function call(body: Record<string, string | null>) {
    setBusy(true); setNote(null);
    try {
      const r = await post({ creationId, keyId: null, idempotencyKey: null, ...body });
      if (r.status === 401) { onSessionEnded(); return null; }
      if (r.status === 429) { setNote("Too many requests. Wait a minute."); return null; }
      if (r.status === 404) { setNote("You are not authorized to manage this product."); return null; }
      if (!r.ok) { setNote("Couldn't complete that right now. Nothing changed that we know of — reload keys to check."); return null; }
      return (await r.json()) as Record<string, unknown>;
    } catch { setNote("Network error. Reload keys to check the current state."); return null; }
    finally { setBusy(false); }
  }
  const load = async () => { const b = await call({ action: "list_keys" }); if (b) setKeys((b["keys"] as KeyMeta[]) ?? []); };

  async function issue(action: "issue" | "rotate", keyId: string | null) {
    if (action === "rotate" && !window.confirm("Rotate this key? The old key stops working immediately.")) return;
    const p = pendingIdem && pendingIdem.action === action && pendingIdem.keyId === keyId ? pendingIdem : { action, keyId, idem: newIdem() };
    setPendingIdem(p);
    const b = await call({ action, keyId, idempotencyKey: p.idem });
    if (!b) return;
    setPendingIdem(null);
    if (typeof b["key"] === "string") setFresh(b["key"]);
    else setNote("That request was already processed. Its key can't be shown again — rotate if you lost it.");
    await load();
  }
  async function revoke(keyId: string) {
    if (!window.confirm("Revoke this key? It stops working on the next request and can't be restored.")) return;
    const b = await call({ action: "revoke", keyId });
    if (b) { setNote(b["revoked"] ? "Key revoked." : "That key was already revoked."); await load(); }
  }

  return (
    <li className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-foreground">{displayName}</span>
        <button type="button" disabled={busy} onClick={() => void load()} className={buttonOutline}>{keys ? "Reload keys" : "Manage keys"}</button>
      </div>
      {fresh && (
        <div role="alert" className="space-y-2 rounded-md border border-warning p-3">
          <p className="text-foreground">New key — shown once. Copy it now; MCPX can't show it again.</p>
          <p className="break-all font-mono text-xs text-foreground">{fresh}</p>
          <div className="flex flex-wrap gap-2"><CopyButton text={fresh} label="Copy key" /><button type="button" className={buttonOutline} onClick={() => setFresh(null)}>I've saved it — hide</button></div>
        </div>
      )}
      {note && <p role="status">{note}</p>}
      {keys && (
        <>
          {keys.length === 0 ? <p>No keys yet.</p> : (
            <ul className="space-y-2">
              {keys.map((k) => (
                <li key={k.keyId} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0">
                  <span className="font-mono text-xs">{k.prefix}… · {k.status} · created {k.createdAt.slice(0, 10)}{k.expiresAt ? ` · expires ${k.expiresAt.slice(0, 10)}` : ""}{k.revokedAt ? ` · revoked ${k.revokedAt.slice(0, 10)}` : ""}</span>
                  {k.status === "active" && (
                    <span className="flex gap-2">
                      <button type="button" disabled={busy} onClick={() => void issue("rotate", k.keyId)} className={buttonOutline}>Rotate</button>
                      <button type="button" disabled={busy} onClick={() => void revoke(k.keyId)} className={buttonOutline}>Revoke</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={busy} onClick={() => void issue("issue", null)} className={buttonOutline}>Issue new key</button>
        </>
      )}
      <ProductAiKey creationId={creationId} onSessionEnded={onSessionEnded} />
    </li>
  );
}
