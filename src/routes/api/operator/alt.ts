// Operator-only, READ-ONLY lookup-table status. Requires a creator sign-in (SIWS) whose wallet is the
// authorised deployer; everyone else gets 403 with no data. Never signs, sends or stores keys.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { ALT_AUTHORITY, ALT_PROGRAM_ID, STATIC_ALT_ENTRIES, nextAltStep, type ExistingTable } from "@/lib/operator/alt-manifest";

const rpcCall = async (url: string, method: string, params: unknown[]) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message ?? "rpc_error"));
  return j.result;
};

export const Route = createFileRoute("/api/operator/alt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let s;
        try { s = await currentSession(authStore, request); } catch { return reply(503, { error: "unavailable" }); }
        if (!s || s.wallet !== ALT_AUTHORITY) return reply(403, { error: "forbidden" });
        const rpc = process.env["MCPX_SOLANA_RPC_URL"] || "https://api.mainnet-beta.solana.com";
        const out: Record<string, unknown> = { authority: ALT_AUTHORITY, network: "mainnet-beta", entries: STATIC_ALT_ENTRIES, mode: "PREVIEW_ONLY" };
        try {
          const [bal, rent, slot] = await Promise.all([
            rpcCall(rpc, "getBalance", [ALT_AUTHORITY, { commitment: "finalized" }]),
            rpcCall(rpc, "getMinimumBalanceForRentExemption", [56 + 32 * STATIC_ALT_ENTRIES.length]),
            rpcCall(rpc, "getSlot", [{ commitment: "finalized" }]),
          ]);
          Object.assign(out, { balanceLamports: bal.value, rentLamports: rent, feeLamports: 10_000, finalizedSlot: slot });
        } catch { out["rpcError"] = "Couldn't read balance or costs from Solana."; }
        // Resume safety: list every lookup table the deployer already owns (authority at byte offset 22).
        let tables: ExistingTable[] | null = null;
        try {
          const accts = await rpcCall(rpc, "getProgramAccounts", [ALT_PROGRAM_ID, { encoding: "base64", commitment: "finalized", filters: [{ memcmp: { offset: 22, bytes: ALT_AUTHORITY } }] }]);
          const bs58 = (await import("bs58")).default;
          tables = [];
          for (const a of accts as { pubkey: string; account: { data: [string, string] } }[]) {
            const d = Uint8Array.from(atob(a.account.data[0]), (c) => c.charCodeAt(0));
            const dv = new DataView(d.buffer);
            const deact = dv.getBigUint64(4, true), lastExt = Number(dv.getBigUint64(12, true));
            const hasAuth = d[21] === 1;
            const addrs: string[] = [];
            for (let o = 56; o + 32 <= d.length; o += 32) addrs.push(bs58.encode(d.subarray(o, o + 32)));
            tables.push({ address: a.pubkey, entries: addrs.length, active: deact === 18446744073709551615n, frozen: !hasAuth, lastExtendedSlot: lastExt, hasAllStatic: STATIC_ALT_ENTRIES.every((e) => addrs.includes(e.address)) });
          }
        } catch { tables = null; }
        return reply(200, { ...out, tables, next: nextAltStep(tables) });
      },
    },
  },
});
