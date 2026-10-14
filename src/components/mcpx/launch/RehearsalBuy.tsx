// SOL Mainnet Rehearsal UI: the label, and the optional separate 0.05 SOL initial buy offered only after the
// creation transaction is confirmed and its 60/25/15 fee config verified on chain. Never automatic.
import { useEffect, useRef, useState } from "react";
import { buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { b64, sameBytes, splitTx } from "@/lib/launch/tx-wire";

const post = (body: unknown) => fetch("/api/creator/launch-buy", {
  method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

export function RehearsalBanner() {
  return (
    <div className="rounded-lg border border-primary/40 bg-card p-4 text-sm">
      <p className="label-mono text-xs text-primary">SOL Mainnet Rehearsal</p>
      <p className="mt-1 text-foreground">This creates a real, permanent token on Solana mainnet. It can't be undone.</p>
      <dl className="mt-3 grid grid-cols-1 gap-1 text-muted-foreground sm:grid-cols-2">
        <div><dt className="inline">Pair: </dt><dd className="inline text-foreground">CHILD / SOL</dd></div>
        <div><dt className="inline">Fee split: </dt><dd className="inline text-foreground">60% you · 25% MCPX tool ops · 15% MCPX platform</dd></div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">One-time rehearsal for an approved wallet only. The optional 0.05 SOL buy is a separate step after your token is confirmed.</p>
    </div>
  );
}

type S = { s: "waiting" } | { s: "ready"; mint: string } | { s: "review"; mint: string; c: any } | { s: "busy"; mint: string; msg: string }
  | { s: "done"; mint: string; sig: string; tokens: string | null } | { s: "declined"; mint: string } | { s: "failed"; mint: string | null; msg: string };

export function RehearsalBuy({ connectedWallet }: { connectedWallet: string | null }) {
  const w = useWallet();
  const [st, setSt] = useState<S>({ s: "waiting" });
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mintOf = (x: S) => ("mint" in x ? x.mint : null);

  useEffect(() => {
    const tick = async () => {
      const r = await post({ op: "status", connectedWallet }).catch(() => null);
      if (r?.status === 200 && r.body.verified) { setSt({ s: "ready", mint: r.body.mint }); return; }
      t.current = setTimeout(tick, 6000);
    };
    void tick();
    return () => clearTimeout(t.current);
  }, [connectedWallet]);

  const prepare = async (mint: string) => {
    setSt({ s: "busy", mint, msg: "Preparing the buy…" });
    const p = await post({ op: "prepare", connectedWallet }).catch(() => null);
    if (!p || p.status !== 200) { setSt({ s: "failed", mint, msg: `The buy couldn't be prepared (${p?.body?.code ?? "unreachable"}). Your token is unaffected.` }); return; }
    setSt({ s: "review", mint, c: p.body });
  };

  const sign = async (mint: string, c: any) => {
    if (!w.signTransaction) { setSt({ s: "failed", mint, msg: "Your wallet can't sign here. Your token is unaffected." }); return; }
    const msg = b64.dec(c.messageBase64);
    let signed: Uint8Array;
    setSt({ s: "busy", mint, msg: "Approve the buy in your wallet…" });
    try { signed = await w.signTransaction(Uint8Array.from([1, ...new Uint8Array(64), ...msg])); }
    catch { setSt({ s: "declined", mint }); return; }
    if (!sameBytes(splitTx(signed).message, msg)) { setSt({ s: "failed", mint, msg: "Your wallet changed the buy, so it was not sent. Your token is unaffected." }); return; }
    setSt({ s: "busy", mint, msg: "Sending the buy…" });
    const sub = await post({ op: "submit", connectedWallet, messageBase64: c.messageBase64, mac: c.mac, expiresAt: c.expiresAt, signedTxBase64: b64.enc(signed) }).catch(() => null);
    if (!sub || sub.status !== 202) { setSt({ s: "failed", mint, msg: `The buy wasn't sent (${sub?.body?.code ?? "unreachable"}). Your token is unaffected.` }); return; }
    const sig = sub.body.signature as string;
    setSt({ s: "busy", mint, msg: "Waiting for Solana to confirm the buy…" });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const r = await post({ op: "result", connectedWallet, signature: sig }).catch(() => null);
      if (r?.body?.state === "confirmed") { setSt({ s: "done", mint, sig, tokens: r.body.tokensReceived ?? null }); return; }
      if (r?.body?.state === "failed") { setSt({ s: "failed", mint, msg: "The buy failed on Solana. Your token is unaffected." }); return; }
    }
    setSt({ s: "failed", mint, msg: `Buy not confirmed yet. Check signature ${sig.slice(0, 8)}… on Solscan before trying again.` });
  };

  const mint = mintOf(st);
  return (
    <div role="status" aria-live="polite" className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      <p className="label-mono text-xs text-primary">Optional initial buy · separate transaction</p>
      {mint && <p className="break-all font-mono text-xs text-muted-foreground">Mint: {mint}</p>}
      {st.s === "waiting" && <p className="text-muted-foreground">Available once your token is confirmed on Solana and its fee split is verified.</p>}
      {st.s === "ready" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonPrimary} onClick={() => prepare(st.mint)}>Review 0.05 SOL buy</button>
          <button type="button" className={buttonOutline} onClick={() => setSt({ s: "declined", mint: st.mint })}>Skip</button>
        </div>
      )}
      {st.s === "review" && (
        <div className="space-y-2">
          <ul className="space-y-1 text-muted-foreground">
            <li>Spend: <span className="text-foreground">0.05 SOL</span> (max slippage {st.c.slippageBps / 100}%)</li>
            <li>Estimated tokens: <span className="text-foreground">{st.c.estimatedTokens ?? "—"}</span> base units</li>
            <li>Minimum you'll receive: <span className="text-foreground">{st.c.minTokensOut}</span> base units, enforced by the Pump program (the buy fails instead of filling lower)</li>
            <li>Network fee: about 0.000005 SOL plus any priority fee your wallet adds</li>
            <li>Simulation: <span className="text-foreground">{st.c.simulation ?? "not run"}</span></li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonPrimary} onClick={() => sign(st.mint, st.c)}>Approve in wallet</button>
            <button type="button" className={buttonOutline} onClick={() => setSt({ s: "declined", mint: st.mint })}>Skip</button>
          </div>
        </div>
      )}
      {st.s === "busy" && <p className="text-muted-foreground">{st.msg}</p>}
      {st.s === "declined" && <p className="text-muted-foreground">No buy made. Your token launch is complete and unaffected.</p>}
      {st.s === "done" && <p className="text-foreground">Buy confirmed{st.tokens ? `: received ${st.tokens} base units` : ""}. <a className="underline" href={`https://solscan.io/tx/${st.sig}`} target="_blank" rel="noreferrer">View on Solscan</a></p>}
      {st.s === "failed" && <p className="text-muted-foreground">{st.msg}</p>}
    </div>
  );
}
