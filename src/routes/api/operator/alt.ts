// Operator-only lookup-table status + wallet-signed creation. Requires a creator sign-in (SIWS) whose wallet is the
// authorised deployer; everyone else gets 403 with no data. The server never holds keys; it only relays a transaction the deployer signed in their own wallet.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore } from "@/lib/creator-auth/store.server";
import { readMutation, reply } from "@/lib/creator-auth/http.server";
import { b64, splitTx, verifyAllSignatures } from "@/lib/launch/tx-wire";
import { validateAltMessage } from "@/lib/operator/alt-tx";
import { ALT_AUTHORITY, ALT_PROGRAM_ID, STATIC_ALT_ENTRIES, nextAltStep, type ExistingTable } from "@/lib/operator/alt-manifest";

const rpcCall = async (url: string, method: string, params: unknown[]) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message ?? "rpc_error"));
  return j.result;
};

const RPC = () => process.env["MCPX_SOLANA_RPC_URL"] || "https://api.mainnet-beta.solana.com";

// Every lookup table the deployer owns (authority at byte offset 22); null when the check fails.
async function listTables(rpc: string, commitment: "finalized" | "confirmed"): Promise<ExistingTable[] | null> {
  try {
    const accts = await rpcCall(rpc, "getProgramAccounts", [ALT_PROGRAM_ID, { encoding: "base64", commitment, filters: [{ memcmp: { offset: 22, bytes: ALT_AUTHORITY } }] }]);
    const bs58 = (await import("bs58")).default;
    const tables: ExistingTable[] = [];
    for (const a of accts as { pubkey: string; account: { data: [string, string] } }[]) {
      const d = Uint8Array.from(atob(a.account.data[0]), (c) => c.charCodeAt(0));
      const dv = new DataView(d.buffer);
      const deact = dv.getBigUint64(4, true), lastExt = Number(dv.getBigUint64(12, true));
      const addrs: string[] = [];
      for (let o = 56; o + 32 <= d.length; o += 32) addrs.push(bs58.encode(d.subarray(o, o + 32)));
      tables.push({ address: a.pubkey, entries: addrs.length, active: deact === 18446744073709551615n, frozen: d[21] !== 1, lastExtendedSlot: lastExt, hasAllStatic: STATIC_ALT_ENTRIES.every((e) => addrs.includes(e.address)), addresses: addrs, authority: d[21] === 1 ? bs58.encode(d.subarray(22, 54)) : null });
    }
    return tables;
  } catch { return null; }
}

async function operator(request: Request) {
  try { const s = await currentSession(authStore, request); return !!s && s.wallet === ALT_AUTHORITY; } catch { return null; }
}

export const Route = createFileRoute("/api/operator/alt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ok = await operator(request);
        if (ok === null) return reply(503, { error: "unavailable" });
        if (!ok) return reply(403, { error: "forbidden" });
        const rpc = RPC();
        const out: Record<string, unknown> = { authority: ALT_AUTHORITY, network: "mainnet-beta", entries: STATIC_ALT_ENTRIES, mode: "WALLET_SIGNING" };
        try {
          const [bal, rent, slot] = await Promise.all([
            rpcCall(rpc, "getBalance", [ALT_AUTHORITY, { commitment: "finalized" }]),
            rpcCall(rpc, "getMinimumBalanceForRentExemption", [56 + 32 * STATIC_ALT_ENTRIES.length]),
            rpcCall(rpc, "getSlot", [{ commitment: "finalized" }]),
          ]);
          Object.assign(out, { balanceLamports: bal.value, rentLamports: rent, feeLamports: 10_000, finalizedSlot: slot });
        } catch { out["rpcError"] = "Couldn't read balance or costs from Solana."; }
        const tables = await listTables(rpc, "finalized");
        return reply(200, { ...out, tables, next: nextAltStep(tables) });
      },
      // Operator actions. Server re-checks the deployer session and the resume rule on every call, and only
      // accepts the two exact lookup-table transactions. Signing happens in the operator's own wallet.
      POST: async ({ request }) => {
        const body = await readMutation(request, ["op", "arg"]);
        if (body instanceof Response) return body;
        const ok = await operator(request);
        if (ok === null) return reply(503, { error: "unavailable" });
        if (!ok) return reply(403, { error: "forbidden" });
        const rpc = RPC();
        const { op, arg } = body;
        try {
          if (op === "blockhash") {
            const [bh, slot] = await Promise.all([rpcCall(rpc, "getLatestBlockhash", [{ commitment: "finalized" }]), rpcCall(rpc, "getSlot", [{ commitment: "finalized" }])]);
            return reply(200, { blockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight, slot });
          }
          if (op === "confirm") {
            if (typeof arg !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(arg)) return reply(400, { error: "invalid_input" });
            const r = await rpcCall(rpc, "getSignatureStatuses", [[arg], { searchTransactionHistory: true }]);
            const v = r.value[0];
            return reply(200, { status: v ? (v.err ? "failed" : v.confirmationStatus) : "unknown", err: v?.err ?? null });
          }
          if (op !== "simulate" && op !== "send") return reply(400, { error: "invalid_input" });
          if (typeof arg !== "string" || arg.length > 2400) return reply(400, { error: "invalid_input" });
          let raw: Uint8Array;
          try { raw = b64.dec(arg); } catch { return reply(400, { error: "invalid_input" }); }
          let parts;
          try { parts = splitTx(raw); } catch { return reply(400, { error: "UNPARSEABLE" }); }
          const v = validateAltMessage(parts.message);
          if (!v.ok) return reply(422, { error: v.code });
          // Resume rule against the freshest (confirmed) view, so an in-flight create blocks a second one.
          const tables = await listTables(rpc, "confirmed");
          const next = nextAltStep(tables);
          if (v.tx.kind === "create" && next.step !== "create") return reply(409, { error: "TABLE_ALREADY_EXISTS", next });
          if (v.tx.kind === "extend") {
            if (next.step !== "extend" || next.table !== v.tx.table) return reply(409, { error: "NOT_THE_RESUMABLE_TABLE", next });
            const have = new Set(tables!.find((t) => t.address === v.tx.table)!.addresses);
            if (v.tx.addresses.some((a) => have.has(a))) return reply(422, { error: "ADDRESS_ALREADY_IN_TABLE" });
          }
          if (op === "simulate") {
            const sim = await rpcCall(rpc, "simulateTransaction", [arg, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
            return reply(200, { tx: v.tx, ok: sim.value.err === null, err: sim.value.err, logs: (sim.value.logs ?? []).slice(-12), unitsConsumed: sim.value.unitsConsumed ?? null });
          }
          const sig = await verifyAllSignatures(raw);
          if (!sig.ok || sig.signers.length !== 1 || sig.signers[0] !== ALT_AUTHORITY) return reply(422, { error: "BAD_SIGNATURE" });
          if (v.tx.kind === "create") {
            // Interrupted-run guard: refuse a create if the deployer sent anything in the last 3 minutes.
            const recent = await rpcCall(rpc, "getSignaturesForAddress", [ALT_AUTHORITY, { limit: 5, commitment: "confirmed" }]);
            const now = Math.floor(Date.now() / 1000);
            if ((recent as { blockTime: number | null }[]).some((r) => r.blockTime === null || now - r.blockTime < 180)) return reply(409, { error: "RECENT_ACTIVITY_WAIT" });
          }
          const sent = await rpcCall(rpc, "sendTransaction", [arg, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }]);
          return reply(200, { signature: sent, tx: v.tx });
        } catch (e) {
          return reply(502, { error: "rpc_error", detail: String((e as Error).message).slice(0, 200) });
        }
      },
    },
  },
});
