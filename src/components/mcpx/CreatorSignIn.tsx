// Explicit, user-initiated creator sign-in. Separate from Connect Wallet; never automatic, never a transaction.
// Session state is read once on mount and after sign-in/out — no polling.
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/context";
import { shortAddress } from "@/lib/wallet/state";
import { buttonOutline, FeatureAvailability } from "@/components/mcpx/primitives";

type Product = { creationId: string; displayName: string; templateId: string };
type State =
  | { kind: "checking" }
  | { kind: "signed_out"; note?: string }
  | { kind: "pending"; step: string }
  | { kind: "signed_in"; wallet: string; expiresAt: string; products: Product[] | null; productsError?: boolean }
  | { kind: "unavailable" };

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify(body) });
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

export function CreatorSignIn() {
  const w = useWallet();
  const [s, setS] = useState<State>({ kind: "checking" });
  const signedWallet = s.kind === "signed_in" ? s.wallet : null;

  const loadProducts = useCallback(async (wallet: string, expiresAt: string) => {
    try {
      const r = await fetch("/api/creator/products", { credentials: "same-origin" });
      if (r.status === 401) return setS({ kind: "signed_out", note: "Your session ended. Sign in again to continue." });
      const b = (await r.json()) as { products?: Product[] };
      setS({ kind: "signed_in", wallet, expiresAt, products: r.ok ? b.products ?? [] : null, productsError: !r.ok });
    } catch {
      setS({ kind: "signed_in", wallet, expiresAt, products: null, productsError: true });
    }
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setS({ kind: "unavailable" });
        const b = (await r.json()) as { signedIn: boolean; wallet?: string; expiresAt?: string };
        if (b.signedIn && b.wallet && b.expiresAt) void loadProducts(b.wallet, b.expiresAt);
        else setS({ kind: "signed_out" });
      })
      .catch(() => live && setS({ kind: "unavailable" }));
    return () => { live = false; };
  }, [loadProducts]);

  const signOut = useCallback(async (note?: string) => {
    setS({ kind: "signed_out", ...(note ? { note } : {}) }); // clear UI immediately
    await post("/api/auth/session", { action: "sign_out" }).catch(() => {});
  }, []);

  // Wallet disconnected, switched account or left mainnet → end the creator session.
  const lastWallet = useRef<string | null>(null);
  useEffect(() => {
    if (!signedWallet) return;
    if (w.status === "loading" || w.status === "connecting") return;
    const ok = w.status === "connected_mainnet" && w.address === signedWallet;
    if (!ok && lastWallet.current !== `${w.status}:${w.address}`) {
      lastWallet.current = `${w.status}:${w.address}`;
      void signOut(w.status === "connected_unsupported_network" ? "Signed out: your wallet left Solana mainnet." : "Signed out: the connected wallet changed or disconnected.");
    }
  }, [w.status, w.address, signedWallet, signOut]);

  async function signIn() {
    if (w.status !== "connected_mainnet" || !w.address || !w.signMessage) return;
    const address = w.address;
    setS({ kind: "pending", step: "Requesting a sign-in message…" });
    try {
      const c = await post("/api/auth/challenge", { address });
      if (c.status === 429) return setS({ kind: "signed_out", note: "Too many attempts. Wait a minute and try again." });
      if (!c.ok) return setS({ kind: c.status >= 500 ? "unavailable" : "signed_out", note: "Couldn't start sign-in." });
      const { nonce, message } = (await c.json()) as { nonce: string; message: string };
      setS({ kind: "pending", step: "Approve the message in your wallet. It is not a transaction." });
      let sig: Uint8Array;
      try {
        sig = await w.signMessage(new TextEncoder().encode(message));
      } catch (e) {
        const unsupported = e instanceof Error && e.message === "unsupported_wallet";
        return setS({ kind: "signed_out", note: unsupported ? "This wallet can't sign messages. Try another wallet." : "You declined the signature. Nothing was signed in." });
      }
      setS({ kind: "pending", step: "Checking signature…" });
      const v = await post("/api/auth/verify", { address, nonce, signature: b64(sig) });
      if (!v.ok) return setS({ kind: v.status >= 500 ? "unavailable" : "signed_out", note: "Sign-in failed. Please try again." });
      const b = (await v.json()) as { wallet: string; expiresAt: string };
      await loadProducts(b.wallet, b.expiresAt);
    } catch {
      setS({ kind: "unavailable" });
    }
  }

  const canSign = w.status === "connected_mainnet" && !!w.signMessage;
  return (
    <section aria-labelledby="creator-h" className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="creator-h" className="text-sm font-semibold">Creator management</h2>
        <FeatureAvailability>{s.kind === "signed_in" ? "Signed in for creator management" : "Not signed in"}</FeatureAvailability>
      </div>
      <div role="status" aria-live="polite" className="mt-3 space-y-4 text-sm text-muted-foreground">
        {s.kind === "checking" && <p>Checking sign-in status…</p>}
        {s.kind === "unavailable" && <p>Creator sign-in is unavailable right now. Your wallet connection and the tools still work.</p>}
        {s.kind === "pending" && <p>{s.step}</p>}
        {s.kind === "signed_out" && (
          <>
            {s.note && <p className="text-foreground">{s.note}</p>}
            <p>Signing in proves you control this wallet by signing a readable message. It is not a transaction, cannot move funds and costs nothing. Connecting a wallet alone never signs you in.</p>
            {canSign ? (
              <button type="button" onClick={() => void signIn()} className={buttonOutline}>Sign in to manage MCP products</button>
            ) : (
              <p>{w.status === "connected_unsupported_network" ? "Switch your wallet to Solana mainnet to sign in." : "Connect a Solana wallet on mainnet first."}</p>
            )}
          </>
        )}
        {s.kind === "signed_in" && (
          <>
            <p className="text-foreground">Signed in as <span className="font-mono">{shortAddress(s.wallet)}</span> until {new Date(s.expiresAt).toLocaleString()}.</p>
            {s.productsError ? <p>Couldn't load your products. Try again later.</p>
              : s.products && s.products.length === 0 ? <p>No verified MCPX products to manage.</p>
              : <ul className="list-disc pl-5">{s.products?.map((p) => <li key={p.creationId}>{p.displayName}</li>)}</ul>}
            <button type="button" onClick={() => void signOut()} className={buttonOutline}>Sign out</button>
          </>
        )}
      </div>
    </section>
  );
}
