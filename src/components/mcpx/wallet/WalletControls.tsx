import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/context";
import { explorerAccountUrl, shortAddress } from "@/lib/wallet/state";
import { buttonOutline, buttonPrimary } from "../primitives";
import { cn } from "@/lib/utils";

export function useCopy() {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMsg("Copied"); }
    catch { setMsg("Copy failed — select the address and copy it manually"); }
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 2000);
  };
  return { msg, copy };
}

/** Compact control for the header / mobile menu. */
export function WalletButton({ className }: { className?: string }) {
  const w = useWallet();
  const sm = "min-h-11 px-4";
  switch (w.status) {
    case "loading":
      return <span className={cn(buttonOutline, sm, "pointer-events-none text-subtle", className)} aria-live="polite">Wallet…</span>;
    case "unavailable":
      return <span className={cn(buttonOutline, sm, "pointer-events-none text-subtle", className)} title={w.message}>Wallet unavailable</span>;
    case "connecting":
      return <button type="button" onClick={w.open} className={cn(buttonOutline, sm, className)} aria-live="polite">Connecting…</button>;
    case "connected_mainnet":
      return (
        <button type="button" onClick={w.openAccount} className={cn(buttonOutline, sm, "gap-2 font-mono", className)} aria-label={`Wallet connected: ${w.address}. Open account controls`}>
          <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />{shortAddress(w.address!)}
        </button>
      );
    case "connected_unsupported_network":
      return <button type="button" onClick={w.switchToMainnet} className={cn(buttonOutline, sm, "border-warning text-warning", className)}>Unsupported network</button>;
    case "error":
      return <button type="button" onClick={w.open} className={cn(buttonOutline, sm, className)}>Retry wallet</button>;
    default:
      return <button type="button" onClick={w.open} className={cn(buttonPrimary, sm, className)}>Connect Wallet</button>;
  }
}

/** Full panel for /dashboard. */
export function WalletPanel() {
  const w = useWallet();
  const { msg, copy } = useCopy();
  const connected = w.status === "connected_mainnet" || w.status === "connected_unsupported_network";
  const url = w.address ? explorerAccountUrl(w.address) : null;
  return (
    <section aria-labelledby="wallet-h" className="rounded-lg border border-border bg-card p-6">
      <p className="label-mono text-subtle">Wallet</p>
      <h2 id="wallet-h" className="mt-2 text-lg font-semibold">
        {connected ? "Wallet connected" : w.status === "unavailable" ? "Wallet connection unavailable" : "Connect a Solana wallet"}
      </h2>
      {connected ? (
        <div className="mt-4 space-y-4">
          <p className="break-all font-mono text-sm text-foreground">{w.address}</p>
          <p className="text-sm text-muted-foreground">
            {w.walletName ? `${w.walletName} · ` : ""}
            {w.status === "connected_mainnet" ? "Solana mainnet" : <span className="text-warning">Unsupported network — switch to Solana mainnet</span>}
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => copy(w.address!)} className={buttonOutline}>Copy address</button>
            {url && <a href={url} target="_blank" rel="noopener noreferrer" className={buttonOutline}>View on Solscan</a>}
            {w.status === "connected_unsupported_network" && <button type="button" onClick={w.switchToMainnet} className={buttonOutline}>Switch to mainnet</button>}
            <button type="button" onClick={w.disconnect} className={buttonOutline}>Disconnect</button>
          </div>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{msg}</p>
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          <p className="text-sm text-muted-foreground">
            {w.status === "unavailable" ? w.message : w.status === "error" ? w.message : "Connecting shows your public address here. It does not create an MCPX account and nothing is signed."}
          </p>
          {w.status === "unavailable"
            ? <button type="button" onClick={() => window.location.reload()} className={buttonOutline}>Reload page to retry</button>
            : <WalletButton />}
        </div>
      )}
      <p className="mt-6 border-t border-border pt-4 text-xs leading-relaxed text-subtle">
        A connected wallet is not a signed-in MCPX account. MCPX never asks you to sign or send anything in this phase.
      </p>
    </section>
  );
}
