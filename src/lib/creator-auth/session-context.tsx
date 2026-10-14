// One shared creator-session state for the whole site. Mounted once inside WalletBoundary.
// Connecting a wallet never signs in; signIn() runs only from an explicit user click and
// signs one readable message (never a transaction). The server stays the authority:
// challenge/nonce, Ed25519 verify, HttpOnly session cookie and CSRF headers are unchanged.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@/lib/wallet/context";

export type SessionState = "checking" | "signed_in" | "signed_out" | "unavailable";

export interface CreatorSession {
  s: SessionState;
  wallet: string | null;
  expiresAt: string | null;
  /** Present while a sign-in is in progress. */
  pending: string | null;
  /** Last user-facing outcome (declined, expired, wallet changed…). */
  note: string | null;
  refresh: () => void;
  signIn: () => Promise<boolean>;
  signOut: (note?: string) => Promise<void>;
  /** Called by protected fetches that got 401: clears the session locally. */
  ended: (note?: string) => void;
}

const noop = async () => {};
const Ctx = createContext<CreatorSession>({
  s: "checking", wallet: null, expiresAt: null, pending: null, note: null,
  refresh: () => {}, signIn: async () => false, signOut: noop, ended: () => {},
});

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify(body) });
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** Classifies a wallet signMessage failure into a short, honest note. */
export function signErrorNote(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
  const code = (e as { code?: unknown })?.code;
  if (msg === "unsupported_wallet") return "This wallet can't sign messages. Try another wallet.";
  if (code === 4001 || /reject|declin|denied|cancel/i.test(msg)) return "You cancelled the verification. Nothing was signed.";
  return "Your wallet couldn't show the verification message. Nothing was signed — try again.";
}

export function CreatorSessionProvider({ children }: { children: ReactNode }) {
  const w = useWallet();
  const [s, setS] = useState<SessionState>("checking");
  const [wallet, setWallet] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const clear = useCallback((n?: string) => {
    setS("signed_out"); setWallet(null); setExpiresAt(null); setNote(n ?? null);
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setS("unavailable");
        const b = (await r.json()) as { signedIn?: boolean; wallet?: string; expiresAt?: string };
        if (b.signedIn && b.wallet) { setWallet(b.wallet); setExpiresAt(b.expiresAt ?? null); setS("signed_in"); }
        else { setWallet(null); setExpiresAt(null); setS("signed_out"); }
      })
      .catch(() => live && setS("unavailable"));
    return () => { live = false; };
  }, [tick]);

  const signOut = useCallback(async (n?: string) => {
    clear(n);
    await post("/api/auth/session", { action: "sign_out" }).catch(() => {});
  }, [clear]);

  // A session is bound to one wallet: disconnect, account switch or leaving mainnet ends it.
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    if (s !== "signed_in" || !wallet) return;
    if (w.status === "loading" || w.status === "connecting") return;
    const ok = w.status === "connected_mainnet" && w.address === wallet;
    const key = `${w.status}:${w.address}`;
    if (!ok && lastSeen.current !== key) {
      lastSeen.current = key;
      void signOut(w.status === "connected_unsupported_network"
        ? "Signed out: your wallet left Solana mainnet."
        : w.status === "disconnected" ? undefined : "Signed out: the connected wallet changed. Verify the new wallet to continue.");
    }
  }, [w.status, w.address, s, wallet, signOut]);

  // Expiry: drop the session locally when it lapses so UI never shows a dead session as live.
  useEffect(() => {
    if (s !== "signed_in" || !expiresAt) return;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (!Number.isFinite(ms)) return;
    const t = setTimeout(() => clear("Your verification expired. Verify again to continue."), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [s, expiresAt, clear]);

  const busy = useRef(false);
  const signIn = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    if (w.status !== "connected_mainnet" || !w.address || !w.signMessage) {
      setNote(w.status === "connected_unsupported_network" ? "Switch your wallet to Solana mainnet first." : "Connect a Solana wallet first.");
      return false;
    }
    busy.current = true;
    const address = w.address;
    setNote(null);
    try {
      setPending("Preparing verification message…");
      const c = await post("/api/auth/challenge", { address });
      if (c.status === 429) { setNote("Too many attempts. Wait a minute and try again."); return false; }
      if (!c.ok) { setNote("Couldn't start verification. Try again."); return false; }
      const { nonce, message } = (await c.json()) as { nonce: string; message: string };
      setPending("Approve the message in your wallet. It is not a transaction.");
      let sig: Uint8Array;
      try { sig = await w.signMessage(new TextEncoder().encode(message)); }
      catch (e) { setNote(signErrorNote(e)); return false; }
      setPending("Checking signature…");
      const v = await post("/api/auth/verify", { address, nonce, signature: b64(sig) });
      if (!v.ok) { setNote(v.status === 400 || v.status === 401 ? "Verification failed or expired. Try again." : "Verification is unavailable right now."); return false; }
      const b = (await v.json()) as { wallet: string; expiresAt: string };
      lastSeen.current = null;
      setWallet(b.wallet); setExpiresAt(b.expiresAt); setS("signed_in");
      return true;
    } catch {
      setNote("Network error. Try again.");
      return false;
    } finally {
      busy.current = false;
      setPending(null);
    }
  }, [w.status, w.address, w.signMessage]);

  const value = useMemo<CreatorSession>(() => ({ s, wallet, expiresAt, pending, note, refresh, signIn, signOut, ended: clear }),
    [s, wallet, expiresAt, pending, note, refresh, signIn, signOut, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useCreatorSessionContext = () => useContext(Ctx);

/** True only when the session belongs to the wallet connected right now on mainnet. */
export function sessionMatchesWallet(session: Pick<CreatorSession, "s" | "wallet">, w: { status: string; address?: string | undefined }) {
  return session.s === "signed_in" && !!session.wallet && w.status === "connected_mainnet" && w.address === session.wallet;
}

/** Only same-site paths are allowed as post-verify destinations. */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}
