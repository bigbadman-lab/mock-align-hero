// Operator-only lookup-table creation. Transactions are built here, checked + simulated by the server, signed
// only in the operator's wallet, then relayed. Data comes only from /api/operator/alt (deployer sign-in required).
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageContainer, PageHeader, RouteError, StatusMessage, buttonOutline } from "@/components/mcpx/primitives";
import { useWallet } from "@/lib/wallet/context";
import { type ExistingTable } from "@/lib/operator/alt-manifest";
import { SignPanel } from "@/components/mcpx/operator/AltSignPanel";

export const Route = createFileRoute("/operator/alt")({
  head: () => ({
    meta: [
      { title: "Operator — MCPX" },
      { name: "description", content: "MCPX operator tools." },
      { property: "og:title", content: "Operator — MCPX" },
      { property: "og:description", content: "MCPX operator tools." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: OperatorAlt,
  errorComponent: RouteError,
});

type Status = {
  authority: string; network: string; entries: { address: string; role: string }[];
  balanceLamports?: number; rentLamports?: number; feeLamports?: number; finalizedSlot?: number; rpcError?: string;
  tables: ExistingTable[] | null; next: { step: string; table?: string };
};

const sol = (l?: number) => (l === undefined ? "—" : `${(l / 1e9).toFixed(6)} SOL`);

function OperatorAlt() {
  const w = useWallet();
  const [st, setSt] = useState<{ s: "loading" } | { s: "forbidden" } | { s: "error" } | { s: "ok"; d: Status }>({ s: "loading" });
  useEffect(() => {
    fetch("/api/operator/alt", { credentials: "same-origin" }).then(async (r) => {
      if (r.status === 403) return setSt({ s: "forbidden" });
      if (!r.ok) return setSt({ s: "error" });
      setSt({ s: "ok", d: await r.json() });
    }, () => setSt({ s: "error" }));
  }, []);

  const connected = w.address ?? null;
  return (
    <>
      <PageHeader label="Operator" title="Static lookup table" intro="Create the MCPX lookup table from the deployer wallet. Each transaction needs your approval in the wallet." className="py-8 sm:py-10" />
      <PageContainer className="space-y-4 py-8">
        {st.s === "loading" && <p className="text-sm text-muted-foreground">Checking operator access…</p>}
        {st.s === "error" && <StatusMessage tone="warning" title="Couldn't load operator status. Try again." />}
        {st.s === "forbidden" && (
          <StatusMessage tone="warning" title="Operator only">
            Verify from the <a href="/dashboard?next=/operator/alt" className="underline">Dashboard</a> with the authorised deployer wallet to view this page.
          </StatusMessage>
        )}
        {st.s === "ok" && (
          <>
            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <dl className="grid gap-2 font-mono text-xs sm:grid-cols-2">
                <Row k="Network" v="Solana mainnet-beta" />
                <Row k="Authority + payer" v={st.d.authority} />
                <Row k="Connected wallet" v={connected ? `${connected}${connected === st.d.authority ? " ✓ matches" : " ✗ does not match"}` : "not connected"} />
                <Row k="Deployer balance" v={sol(st.d.balanceLamports)} />
                <Row k="Table deposit (refundable)" v={sol(st.d.rentLamports)} />
                <Row k="Network fees (2 transactions)" v={sol(st.d.feeLamports)} />
                <Row k="Total needed" v={st.d.rentLamports !== undefined ? sol(st.d.rentLamports + (st.d.feeLamports ?? 0)) : "—"} />
                <Row k="Next step" v={stepText(st.d.next)} />
              </dl>
              {st.d.rpcError && <p className="mt-2 text-xs text-warning">{st.d.rpcError}</p>}
            </div>

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">Tables already owned by the deployer</p>
              {st.d.tables === null ? <p className="mt-1 text-warning">Couldn't check. Creation stays blocked until this check succeeds.</p>
                : st.d.tables.length === 0 ? <p className="mt-1 text-muted-foreground">None — a new table would be created.</p>
                : <ul className="mt-2 space-y-1 font-mono text-xs">{st.d.tables.map((t) => <li key={t.address}>{t.address} · {t.entries} entries · {t.active ? "active" : "deactivated"} · {t.frozen ? "frozen" : "extendable"} · {t.hasAllStatic ? "has all 13" : "missing static entries"}</li>)}</ul>}
            </div>

            <SignPanel d={st.d} connected={connected} />

            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-left font-mono text-xs">
                <thead className="text-subtle"><tr><th className="p-2">#</th><th className="p-2">Address</th><th className="p-2">Role</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {st.d.entries.map((e, i) => <tr key={e.address}><td className="p-2 text-subtle">{i + 1}</td><td className="p-2 text-foreground">{e.address}</td><td className="p-2 text-muted-foreground">{e.role}</td></tr>)}
                </tbody>
              </table>
            </div>

            <button type="button" className={buttonOutline} onClick={() => location.reload()}>Refresh</button>
          </>
        )}
      </PageContainer>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="min-w-0"><dt className="text-subtle">{k}</dt><dd className="break-all text-foreground">{v}</dd></div>;
}
function stepText(n: { step: string; table?: string }) {
  return n.step === "create" ? "Create a new table, then add 13 addresses"
    : n.step === "extend" ? `Resume: add missing addresses to ${n.table}`
    : n.step === "done" ? `Done: ${n.table}`
    : n.step === "conflict" ? "Blocked: unexpected existing tables — review manually"
    : "Blocked: couldn't check existing tables";
}
