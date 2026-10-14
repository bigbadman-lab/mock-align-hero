// Operator lookup-table signing panel. Sequence per transaction: Prepare (fresh blockhash, build, server
// validation + simulation, show details) → Approve in wallet → server relays → wait for finalization.
// No private keys ever touch this page; the wallet extension signs.
import { useEffect, useState } from "react";
import { StatusMessage, buttonOutline, buttonPrimary } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { ALT_AUTHORITY, STATIC_ALT_ENTRIES, type ExistingTable } from "@/lib/operator/alt-manifest";
import { b64 } from "@/lib/launch/tx-wire";

type D = { rentLamports?: number; finalizedSlot?: number; tables: ExistingTable[] | null; next: { step: string; table?: string } };
type Prepared = { kind: "create" | "extend"; table: string; bytes: Uint8Array; size: number; blockhash: string; addresses: string[]; sim: { ok: boolean; err: unknown; logs: string[]; unitsConsumed: number | null } };
const PENDING = "mcpx-alt-pending";
const sol = (l: number) => `${(l / 1e9).toFixed(6)} SOL`;

async function api(op: string, arg: string | null) {
  const r = await fetch("/api/operator/alt", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-mcpx-csrf": "1" }, body: JSON.stringify({ op, arg }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `http_${r.status}`);
  return j;
}

export function SignPanel({ d, connected }: { d: D; connected: string | null }) {
  const w = useWallet();
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ sig: string; status: string } | null>(null);

  // Resume waiting for a transaction sent before a refresh/interruption.
  useEffect(() => { const s = sessionStorage.getItem(PENDING); if (s) setPending({ sig: s, status: "checking" }); }, []);
  useEffect(() => {
    if (!pending || pending.status === "finalized" || pending.status === "failed") return;
    const t = setTimeout(async () => {
      try {
        const r = await api("confirm", pending.sig);
        if (r.status === "finalized") { sessionStorage.removeItem(PENDING); setPending({ ...pending, status: "finalized" }); setTimeout(() => location.reload(), 1500); }
        else if (r.status === "failed") { sessionStorage.removeItem(PENDING); setPending({ ...pending, status: "failed" }); }
        else setPending({ ...pending, status: r.status ?? "unknown" });
      } catch { setPending({ ...pending, status: "checking" }); }
    }, 2500);
    return () => clearTimeout(t);
  }, [pending]);

  const step = d.next.step;
  const walletOk = connected === ALT_AUTHORITY;

  async function prepare() {
    setErr(null); setPrep(null); setBusy("Preparing and simulating…");
    try {
      const { blockhash, slot } = await api("blockhash", null);
      const web3 = await import("@solana/web3.js");
      const auth = new web3.PublicKey(ALT_AUTHORITY);
      let ix, table: string, addresses: string[];
      if (step === "create") {
        const [c, t] = web3.AddressLookupTableProgram.createLookupTable({ authority: auth, payer: auth, recentSlot: slot });
        ix = c; table = t.toBase58(); addresses = [];
      } else {
        table = d.next.table!;
        const have = new Set(d.tables?.find((t) => t.address === table)?.addresses ?? []);
        addresses = STATIC_ALT_ENTRIES.map((e) => e.address).filter((a) => !have.has(a));
        ix = web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: new web3.PublicKey(table), authority: auth, payer: auth, addresses: addresses.map((a) => new web3.PublicKey(a)) });
      }
      const bytes = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: auth, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message()).serialize();
      const sim = await api("simulate", b64.enc(bytes));
      setPrep({ kind: step as "create" | "extend", table, bytes, size: bytes.length, blockhash, addresses, sim });
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(null);
  }

  async function approve() {
    if (!prep || !w.signTransaction) return;
    setErr(null); setBusy("Waiting for approval in your wallet…");
    try {
      const signed = await w.signTransaction(prep.bytes);
      setBusy("Sending…");
      const r = await api("send", b64.enc(signed));
      sessionStorage.setItem(PENDING, r.signature);
      setPending({ sig: r.signature, status: "sent" }); setPrep(null);
    } catch (e) { setErr(/reject|declin|denied/i.test(String(e)) ? "You declined in the wallet. Nothing was sent." : String((e as Error).message)); }
    setBusy(null);
  }

  if (step === "done") {
    const t = d.tables!.find((x) => x.address === d.next.table)!;
    const checks: [string, boolean][] = [
      ["Authority is the deployer (still extendable)", t.authority === ALT_AUTHORITY && !t.frozen],
      ["Active (not deactivated)", t.active],
      [`All ${STATIC_ALT_ENTRIES.length} static addresses present`, t.hasAllStatic],
      ["No unexpected addresses", (t.addresses ?? []).every((a) => STATIC_ALT_ENTRIES.some((e) => e.address === a))],
      ["Usable (last change is finalized)", d.finalizedSlot !== undefined && t.lastExtendedSlot < d.finalizedSlot],
    ];
    const pass = checks.every((c) => c[1]);
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm">
        <p className="text-foreground">Mainnet verification · {pass ? "PASS" : "not yet passing"}</p>
        <ul className="mt-2 space-y-1 text-xs">{checks.map(([k, ok]) => <li key={k} className={ok ? "text-primary" : "text-warning"}>{ok ? "✓" : "✗"} {k}</li>)}</ul>
        <p className="mt-3 text-xs text-subtle">Record for the $MCP go-live step (Builder #2):</p>
        <p className="mt-1 break-all font-mono text-xs text-foreground">MCPX_LOOKUP_TABLE={t.address}</p>
        <a className="mt-2 inline-block text-xs underline" href={`https://solscan.io/account/${t.address}`} target="_blank" rel="noreferrer">View on Solscan</a>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      <p className="text-foreground">{step === "create" ? "Transaction 1 of 2 · Create table" : step === "extend" ? "Transaction 2 of 2 · Add addresses" : "Signing unavailable"}</p>
      {!walletOk && <p className="text-xs text-warning">Connect the deployer wallet ({ALT_AUTHORITY.slice(0, 6)}…) to continue.</p>}
      {(step === "conflict" || step === "check_failed") && <p className="text-xs text-warning">Blocked until the existing-table check is clean.</p>}

      {pending && (
        <p className="font-mono text-xs text-muted-foreground">
          Last transaction: {pending.sig.slice(0, 16)}… · {pending.status}
          {pending.status === "failed" && " — nothing changed; prepare again."}
        </p>
      )}

      {prep && (
        <dl className="grid gap-1 font-mono text-xs">
          <Item k="Network" v="Solana mainnet-beta" />
          <Item k="Instruction" v={prep.kind === "create" ? "Address Lookup Table · CreateLookupTable" : `Address Lookup Table · ExtendLookupTable (+${prep.addresses.length})`} />
          <Item k="Table" v={prep.table} />
          <Item k="Signer · authority · payer" v={ALT_AUTHORITY} />
          <Item k="Size" v={`${prep.size} bytes`} />
          <Item k="Network fee" v={sol(5000)} />
          {prep.kind === "extend" && d.rentLamports !== undefined && <Item k="Table deposit (refundable on close)" v={`≈ ${sol(d.rentLamports)}`} />}
          <Item k="Simulation" v={prep.sim.ok ? `OK${prep.sim.unitsConsumed ? ` · ${prep.sim.unitsConsumed} compute units` : ""}` : `FAILED ${JSON.stringify(prep.sim.err)}`} />
          {prep.addresses.length > 0 && <Item k="Addresses added" v={prep.addresses.join(", ")} />}
        </dl>
      )}
      {err && <StatusMessage tone="warning" title={err} />}
      {busy && <p className="text-xs text-muted-foreground">{busy}</p>}

      {(step === "create" || step === "extend") && walletOk && !busy && (!pending || pending.status === "finalized" || pending.status === "failed") && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonOutline} onClick={prepare}>{prep ? "Prepare again" : "Prepare & simulate"}</button>
          {prep?.sim.ok && <button type="button" className={buttonPrimary} onClick={approve} disabled={!w.signTransaction}>Approve in wallet</button>}
        </div>
      )}
      <p className="text-xs text-subtle">Your wallet will show this exact transaction. MCPX never asks for a private key or recovery phrase.</p>
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return <div className="min-w-0"><dt className="inline text-subtle">{k}: </dt><dd className="inline break-all text-foreground">{v}</dd></div>;
}
