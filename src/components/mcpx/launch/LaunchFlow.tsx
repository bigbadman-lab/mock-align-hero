// Review → Launch. Prepares the unsigned launch from the creator's saved launch, re-verifies it, and
// only continues to the wallet when the builder reports it launch-ready. While launching is switched
// off on the server, the button stays disabled. Never signs with any server key; never claims "live"
// until the on-chain verifier links a product page.
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { buttonPrimary } from "@/components/mcpx/primitives";
import logo from "@/assets/mcp-monitor-logo.png.asset.json";
import type { DraftView } from "./DraftPersistence";
import { useWallet } from "@/lib/wallet/context";
import { assembleTx, b64, messageSigners, sameBytes, splitTx } from "@/lib/launch/tx-wire";
import { RehearsalBanner, RehearsalBuy } from "./RehearsalBuy";
import { BLOCKER_TEXT, STAGES, chainConfirmed, claimOutcome, launchBlocker, type LaunchStage } from "@/lib/launch/launch-flow";

const post = (url: string, body: unknown) => fetch(url, {
  method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const MESSAGES: Record<string, string> = {
  LAUNCH_REAUTH_REQUIRED: "Sign in again from the Dashboard to confirm your wallet, then press Launch again.",
  CONNECTED_WALLET_MISMATCH: "The connected wallet isn't the one you signed in with.",
  WALLET_DISCONNECTED: "Connect your wallet first.",
  CREATOR_SESSION_REQUIRED: "Sign in as a creator first.",
  DRAFT_CHANGED: "Your launch details changed. Press Review again.",
  METADATA_NOT_PREPARED: "Your token details aren't ready yet. Press Review again.",
  REHEARSAL_BUSY: "The one-time rehearsal is already reserved for another attempt. Nothing was signed. Ask the MCPX operator to release it.",
  REHEARSAL_ALREADY_SUBMITTED: "The rehearsal launch was already sent. It can't be launched twice.",
  REHEARSAL_USED: "The one-time rehearsal has already been used.",
  REHEARSAL_UNAVAILABLE: "The rehearsal permission couldn't be checked, so nothing was signed.",
  ALT_UNAVAILABLE: "The lookup table couldn't be read right now, so nothing was signed. Try again shortly.",
  ALT_DEACTIVATED: "The lookup table is not active, so nothing was signed.",
  ALT_INSUFFICIENT: "The lookup table is missing addresses this launch needs, so nothing was signed.",
  TX_TOO_LARGE: "The launch transaction is too large, so nothing was signed.",
};
const CLAIM_KEY = "mcpx:launch-claim";

type Run =
  | { s: "idle" }
  | { s: "running"; stage: LaunchStage; mint?: string; signature?: string; slow?: boolean }
  | { s: "held" }
  | { s: "live"; slug: string; mint: string }
  | { s: "failed"; msg: string };

export function LaunchFlow({ saved, signedInWallet, connectedWallet }: { saved: DraftView | null; signedInWallet: string | null; connectedWallet: string | null }) {
  const w = useWallet();
  const [enabled, setEnabled] = useState(false);
  const [rehearsal, setRehearsal] = useState(false);
  const [run, setRun] = useState<Run>({ s: "idle" });
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Rehearsal: the one-time mint key stays in memory for this page so a declined signature can retry the same reservation.
  const mintKey = useRef<{ draftId: string; kp: CryptoKeyPair; mint: string } | null>(null);
  // The server decides rehearsal from the signed-in session; the browser only displays it.
  useEffect(() => { fetch("/api/creator/launch-prepare", { credentials: "same-origin" }).then((r) => r.json()).then((b) => { setEnabled(b?.enabled === true || b?.rehearsal === true); setRehearsal(b?.rehearsal === true); }, () => setEnabled(false)); }, [signedInWallet]);

  // Resume a launch that was already submitted (e.g. after a page reload).
  const watch = (claimId: string) => {
    setRun({ s: "running", stage: "confirming" });
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await fetch(`/api/creator/launch-claim?id=${claimId}`, { credentials: "same-origin" });
        const b = await r.json().catch(() => ({}));
        const o = claimOutcome(b);
        if (o === "live") { sessionStorage.removeItem(CLAIM_KEY); setRun({ s: "live", slug: b.slug, mint: b.mint }); return; }
        if (o === "rejected") { sessionStorage.removeItem(CLAIM_KEY); setRun({ s: "failed", msg: "Solana didn't confirm this launch. Nothing was registered." }); return; }
        // Solana has the token; only product registration is outstanding. Never reported as "live".
        if (chainConfirmed(b)) setRun({ s: "running", stage: "registering", mint: b.mint, signature: b.signature, slow: Date.now() - started > 10 * 60_000 });
        else if (b.chain === "failed") { sessionStorage.removeItem(CLAIM_KEY); setRun({ s: "failed", msg: "Solana rejected this transaction. No token was created." }); return; }
      } catch { /* keep waiting */ }
      poll.current = setTimeout(tick, 5000);
    };
    void tick();
  };
  useEffect(() => {
    const id = sessionStorage.getItem(CLAIM_KEY);
    if (id) watch(id);
    return () => clearTimeout(poll.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blocker = launchBlocker({ serverEnabled: enabled, signedInWallet, connectedWallet, metadataReady: !!saved?.metadata });

  const launch = async () => {
    if (blocker || !saved) return;
    setRun({ s: "running", stage: "preparing" });
    try {
      const bs58 = (await import("bs58")).default;
      let kp: CryptoKeyPair, mint: string;
      if (rehearsal && mintKey.current?.draftId === saved.id) ({ kp, mint } = mintKey.current);
      else {
        kp = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
        mint = bs58.encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
        if (rehearsal) mintKey.current = { draftId: saved.id, kp, mint };
      }
      const p = await post("/api/creator/launch-prepare", { op: "prepare", draftId: saved.id, revision: saved.revision, mint, idempotencyKey: crypto.randomUUID(), connectedWallet });
      if (p.status !== 200) { setRun({ s: "failed", msg: MESSAGES[p.body.code] ?? "We couldn't prepare your launch. Try again." }); return; }
      setRun({ s: "running", stage: "checking" });
      const v = await post("/api/creator/launch-prepare", { op: "verify", messageBase64: p.body.messageBase64, binding: p.body.binding, bindingMac: p.body.bindingMac, connectedWallet, draftId: saved.id, revision: saved.revision });
      if (v.status !== 200) { setRun({ s: "failed", msg: MESSAGES[v.body.code] ?? "The launch didn't pass its safety check, so nothing was signed." }); return; }
      // Wallet signing is switched off: the builder must report the transaction launch-ready first.
      if (v.body.launchReady !== true) { setRun({ s: "held" }); return; }

      // Wallet signature. The new mint's key exists only in this tab and signs first; the wallet adds the creator's.
      setRun({ s: "running", stage: "signing" });
      const msg = b64.dec(p.body.messageBase64);
      const signers = messageSigners(msg);
      if (signers.length !== 2 || signers[0] !== connectedWallet || signers[1] !== mint) { setRun({ s: "failed", msg: "The launch transaction didn't match your wallet, so nothing was signed." }); return; }
      if (!w.signTransaction) { setRun({ s: "failed", msg: "Your wallet can't sign transactions here. Try Phantom or Solflare." }); return; }
      const mintSig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" } as any, kp.privateKey, msg));
      let signed: Uint8Array;
      try { signed = await w.signTransaction(assembleTx(msg, [null, mintSig])); }
      catch { setRun({ s: "failed", msg: "You declined the signature in your wallet. Nothing was sent." }); return; }
      if (!sameBytes(splitTx(signed).message, msg)) { setRun({ s: "failed", msg: "Your wallet changed the transaction, so it was not sent." }); return; }

      // Broadcast + claim. From here the launch is tracked until Solana confirms it.
      setRun({ s: "running", stage: "confirming" });
      const sub = await post("/api/creator/launch-submit", { draftId: saved.id, revision: saved.revision, mint, signedTxBase64: b64.enc(signed), messageBase64: p.body.messageBase64, binding: p.body.binding, bindingMac: p.body.bindingMac });
      if (sub.status !== 202 || !sub.body.claimId) {
        setRun({ s: "failed", msg: sub.body.code === "BROADCAST_FAILED" ? "Solana refused the transaction (often low SOL for fees). Nothing was created." : MESSAGES[sub.body.code] ?? "We couldn't send your launch. Try again." });
        return;
      }
      sessionStorage.setItem(CLAIM_KEY, sub.body.claimId);
      watch(sub.body.claimId);
    } catch {
      setRun({ s: "failed", msg: "Something went wrong before signing. Nothing was signed or sent." });
    }
  };

  const showBuy = rehearsal && (run.s === "running" && (run.stage === "confirming" || run.stage === "registering") || run.s === "live");
  if (run.s === "idle") {
    return (
      <div className="space-y-3">
        {rehearsal && <RehearsalBanner />}
        <button type="button" className={buttonPrimary} disabled={!!blocker} onClick={launch}>Launch token</button>
        {blocker && <p className="text-sm text-muted-foreground">{BLOCKER_TEXT[blocker]}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rehearsal && <RehearsalBanner />}
      <LaunchProgress run={run} onRetry={() => setRun({ s: "idle" })} />
      {showBuy && <RehearsalBuy connectedWallet={connectedWallet} />}
    </div>
  );
}

function LaunchProgress({ run, onRetry }: { run: Exclude<Run, { s: "idle" }>; onRetry: () => void }) {
  const current = run.s === "running" ? run.stage : run.s === "live" ? "live" : null;
  const idx = current ? STAGES.findIndex((x) => x.id === current) : -1;
  const busy = run.s === "running";
  return (
    <div role="status" aria-live="polite" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-col items-center gap-4 border-b border-border bg-surface-2 px-4 py-8 text-center">
        <div className="relative h-28 w-28">
          {busy && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary/20" />}
          <span aria-hidden className={`absolute -inset-2 rounded-full border-2 ${busy ? "animate-spin border-primary/20 border-t-primary" : run.s === "live" ? "border-primary" : "border-border-strong"}`} style={busy ? { animationDuration: "1.4s" } : undefined} />
          <img src={logo.url} alt="" width={112} height={112} className="relative h-28 w-28 rounded-full object-cover [image-rendering:pixelated]" />
        </div>
        <div>
          <p className="label-mono text-xs text-primary">{run.s === "live" ? "Launch complete" : run.s === "held" ? "Launch ready" : run.s === "failed" ? "Launch stopped" : "Launching"}</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground">
            {run.s === "live" ? "Your token is live" : run.s === "running" && run.stage === "registering" ? "Token created" : run.s === "held" ? "Everything checks out" : run.s === "failed" ? "Your launch didn't go through" : "Your token is processing"}
          </h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {run.s === "live" ? "It's verified on Solana and its MCP tool is ready to connect."
              : run.s === "held" ? "Your launch passed every check. Launching opens soon. Nothing was signed or sent."
              : run.s === "failed" ? run.msg
              : run.stage === "registering" ? (run.slow
                ? "Your token is on Solana. Setting up the MCP product is taking longer than usual — it's safe to leave; it will appear on your Dashboard once ready."
                : "Your token is on Solana. Setting up its MCP product can take up to 5 minutes — keep this page open or check your Dashboard later.")
              : "Keep this page open. This usually takes under a minute."}
          </p>
          {run.s === "running" && run.stage === "registering" && run.mint && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              Mint {run.mint.slice(0, 6)}…{run.mint.slice(-6)} ·{" "}
              <a className="underline underline-offset-4 hover:text-primary" href={`https://solscan.io/token/${run.mint}`} target="_blank" rel="noreferrer">Solscan</a>
              {run.signature && <> · <a className="underline underline-offset-4 hover:text-primary" href={`https://solscan.io/tx/${run.signature}`} target="_blank" rel="noreferrer">Transaction</a></>}
            </p>
          )}
        </div>
        {run.s === "live" && (
          <Link to="/mcp/$slug" params={{ slug: run.slug }} className={buttonPrimary}>View your token and MCP page →</Link>
        )}
        {(run.s === "failed" || run.s === "held") && <button type="button" onClick={onRetry} className="text-sm text-foreground underline">Back</button>}
      </div>
      <ol className="divide-y divide-border">
        {STAGES.map((st, i) => {
          const done = idx > i || run.s === "live";
          const active = busy && idx === i;
          return (
            <li key={st.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span aria-hidden className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] ${done ? "border-primary bg-primary text-primary-foreground" : active ? "border-primary text-primary" : "border-border-strong text-subtle"}`}>
                {done ? "✓" : active ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> : i + 1}
              </span>
              <span className={done || active ? "text-foreground" : "text-subtle"}>{st.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
