// Launch transaction check: prepares the unsigned launch from the saved draft and verifies it is bound
// to the signed-in wallet. Shown only when the server reports child launching enabled. Never signs or
// sends; the throwaway mint key is generated in memory and discarded.
import { useEffect, useState } from "react";
import { buttonOutline } from "@/components/mcpx/primitives";
import type { DraftView } from "./DraftPersistence";

const post = (body: unknown) => fetch("/api/creator/launch-prepare", {
  method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const MESSAGES: Record<string, string> = {
  LAUNCH_REAUTH_REQUIRED: "Sign in again from the Dashboard to confirm this wallet, then retry.",
  CONNECTED_WALLET_MISMATCH: "The connected wallet is not the one you signed in with.",
  WALLET_DISCONNECTED: "Connect your wallet first.",
  CREATOR_SESSION_REQUIRED: "Sign in as a creator first.",
  DRAFT_CHANGED: "This draft changed. Save it again and retry.",
  METADATA_NOT_PREPARED: "Publish the token metadata first.",
};

export function LaunchTxCheck({ saved, wallet }: { saved: DraftView; wallet: string | null }) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  useEffect(() => { fetch("/api/creator/launch-prepare").then((r) => r.json()).then((b) => setEnabled(b?.enabled === true), () => setEnabled(false)); }, []);
  if (!enabled || !saved.metadata) return null;

  const run = async () => {
    setState("busy");
    try {
      const bs58 = (await import("bs58")).default;
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
      const mint = bs58.encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
      const p = await post({ op: "prepare", draftId: saved.id, revision: saved.revision, mint, idempotencyKey: crypto.randomUUID(), connectedWallet: wallet });
      if (p.status !== 200) { setState(MESSAGES[p.body.code] ?? `Not prepared (${p.body.code ?? p.status}).`); return; }
      const v = await post({ op: "verify", messageBase64: p.body.messageBase64, binding: p.body.binding, bindingMac: p.body.bindingMac, connectedWallet: wallet, draftId: saved.id, revision: saved.revision });
      setState(v.status === 200 ? "Checked: the launch transaction pays 60% to your signed-in wallet, 25% to MCPX tool operations and 15% to the MCPX platform. Signing is not available yet." : MESSAGES[v.body.code] ?? `Check failed (${v.body.code ?? v.status}).`);
    } catch { setState("Couldn't reach the launch service."); }
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4">
      <button type="button" className={buttonOutline} disabled={state === "busy" || !wallet} onClick={run}>Check launch transaction (no signing)</button>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{state === "idle" ? "Builds the unsigned transaction and confirms it pays your own wallet. Nothing is signed or sent." : state === "busy" ? "Checking…" : state}</p>
    </div>
  );
}
