// Shared browser-side read of the creator sign-in session. One GET per mount or explicit
// refresh — never polling. Returns only the public wallet address the session already exposes.
import { useCallback, useEffect, useState } from "react";

export type SessionState = "checking" | "signed_in" | "signed_out" | "unavailable";

export function useCreatorSession() {
  const [s, setS] = useState<SessionState>("checking");
  const [wallet, setWallet] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    setS("checking");
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setS("unavailable");
        const b = (await r.json()) as { signedIn?: boolean; wallet?: string };
        if (b.signedIn && b.wallet) { setWallet(b.wallet); setS("signed_in"); } else { setWallet(null); setS("signed_out"); }
      })
      .catch(() => live && setS("unavailable"));
    return () => { live = false; };
  }, [tick]);

  return { s, wallet, refresh };
}
