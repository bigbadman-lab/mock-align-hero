// Smart Money Tracker v1 — on-demand, bounded look at recent activity for up to 3 wallets the caller chooses.
// Not monitoring, alerts, copy-trading or a claim the wallets are "smart". Reuses Whale Watch's proven
// native-SOL transfer decoder; token transfers, swaps and PnL are out of scope.
// Bounded: ≤3 getSignaturesForAddress (20 each) + ≤5 getTransaction per wallet = ≤18 calls, concurrency 3, one deadline.
import { RpcError, rpcFetch, parseAddress, formatUnits } from "./inspect.mjs";
import { extractTransfers } from "./whale.mjs";

export const SMT_SCHEMA = "mcpx.tool-execution.smart-money-tracker.v1";
export const SMT_TOOL_ID = "smart_money_tracker";
export const SMT_COMMITMENT = "finalized";
export const MAX_WALLETS = 3;
export const SIGNATURES_PER_WALLET = 20;
export const DETAILS_PER_WALLET = 5;
export const CONCURRENCY = 3;
export const RUN_BUDGET_MS = 16_000;
export const HIGHLIGHT_LAMPORTS = "1000000000"; // fixed: native SOL transfers ≥ 1 SOL are highlighted
export const MAX_CALLS = MAX_WALLETS * (1 + DETAILS_PER_WALLET);

/** Exact keys {wallets}; 1–3 canonical, unique addresses. */
export function validInput(i) {
  if (!i || typeof i !== "object" || Array.isArray(i) || Object.keys(i).join(",") !== "wallets") return false;
  const w = i.wallets;
  return Array.isArray(w) && w.length >= 1 && w.length <= MAX_WALLETS && w.every((a) => parseAddress(a) === a) && new Set(w).size === w.length;
}

export async function trackWallets({ wallets, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date(), budgetMs = RUN_BUDGET_MS }) {
  if (!validInput({ wallets })) throw new RpcError("invalid_input", "invalid wallets");
  const deadline = Date.now() + budgetMs;
  let calls = 0;
  const rpc = (m, p) => { if (++calls > MAX_CALLS) throw new RpcError("internal", "call budget"); return rpcFetch(rpcUrl, m, p, fetchImpl, signal); };

  // Phase 1: signatures for each wallet (parallel, ≤3 calls).
  const sigRes = await Promise.allSettled(wallets.map((w) => rpc("getSignaturesForAddress", [w, { limit: SIGNATURES_PER_WALLET, commitment: SMT_COMMITMENT }])));
  const per = wallets.map((address, wi) => {
    const r = sigRes[wi];
    if (r.status === "rejected") return { address, status: "unavailable", reason: r.reason instanceof RpcError ? r.reason.kind : "internal", sigs: [] };
    const s = r.value;
    const ok = Array.isArray(s) && s.length <= SIGNATURES_PER_WALLET && s.every((x) => typeof x?.signature === "string" && x.signature.length <= 88 && Number.isSafeInteger(x.slot));
    return ok ? { address, status: "ok", reason: null, sigs: s } : { address, status: "unavailable", reason: "bad_response", sigs: [] };
  });

  // Phase 2: decode the newest few successful-or-failed transactions per wallet under one shared deadline.
  const jobs = per.flatMap((p, wi) => p.sigs.slice(0, DETAILS_PER_WALLET).map((s, si) => ({ wi, si, s })));
  const outcome = new Map();
  let next = 0;
  const loop = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const key = `${j.wi}:${j.si}`;
      if (Date.now() >= deadline || signal?.aborted) { outcome.set(key, { kind: "budget" }); continue; }
      if (j.s.err !== null && j.s.err !== undefined) { outcome.set(key, { kind: "failed_tx" }); continue; } // no call needed: nothing moved
      try {
        const tx = await rpc("getTransaction", [j.s.signature, { commitment: SMT_COMMITMENT, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
        if (tx === null || !tx.meta || typeof tx.meta !== "object") outcome.set(key, { kind: "unavailable" });
        else if (tx.meta.err !== null) outcome.set(key, { kind: "failed_tx" });
        else { const r = extractTransfers(tx, per[j.wi].address, j.s.signature); outcome.set(key, { kind: r.undecodable ? "partial" : "decoded", transfers: r.transfers }); }
      } catch (e) { outcome.set(key, { kind: e instanceof RpcError && e.kind === "unsupported_version" ? "unsupported_version" : "unavailable" }); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, loop));

  const hi = BigInt(HIGHLIGHT_LAMPORTS);
  const walletsOut = per.map((p, wi) => {
    const signatures = p.sigs.map((s, si) => ({
      signature: s.signature, slot: s.slot, blockTime: Number.isSafeInteger(s.blockTime) ? s.blockTime : null,
      succeeded: s.err === null || s.err === undefined,
      detail: si < DETAILS_PER_WALLET ? outcome.get(`${wi}:${si}`)?.kind ?? "budget" : "not_inspected",
    }));
    const transfers = p.sigs.slice(0, DETAILS_PER_WALLET).flatMap((_, si) => outcome.get(`${wi}:${si}`)?.transfers ?? []);
    const times = signatures.map((s) => s.blockTime).filter((t) => t !== null);
    const c = (k) => signatures.filter((s) => s.detail === k).length;
    return {
      address: p.address, status: p.status, reason: p.reason, signatures, transfers,
      highlights: transfers.filter((t) => BigInt(t.lamports) >= hi).map((t) => ({ signature: t.signature, direction: t.direction, sol: t.sol, slot: t.slot })),
      counts: {
        signaturesSeen: signatures.length, failedTransactions: signatures.filter((s) => !s.succeeded).length,
        decoded: c("decoded") + c("partial"), partiallyDecoded: c("partial"), unavailable: c("unavailable") + c("unsupported_version"),
        truncatedByBudget: c("budget"), notInspected: c("not_inspected"), missingBlockTime: signatures.length - times.length,
      },
      window: { newestSlot: p.sigs[0]?.slot ?? null, oldestSlot: p.sigs.at(-1)?.slot ?? null, newestBlockTime: times.length ? Math.max(...times) : null, oldestBlockTime: times.length ? Math.min(...times) : null },
    };
  });
  const complete = walletsOut.every((w) => w.status === "ok" && w.counts.unavailable === 0 && w.counts.truncatedByBudget === 0 && w.counts.partiallyDecoded === 0);
  return {
    schema: SMT_SCHEMA, executionId, toolId: SMT_TOOL_ID, network: "solana-mainnet", commitment: SMT_COMMITMENT,
    fetchedAt: now().toISOString(), wallets: walletsOut, complete, rpcCalls: calls,
    limits: { signaturesPerWallet: SIGNATURES_PER_WALLET, detailsPerWallet: DETAILS_PER_WALLET, highlightLamports: HIGHLIGHT_LAMPORTS, highlightSol: formatUnits(HIGHLIGHT_LAMPORTS, 9) },
    scope: "Recent signatures (max 20 per wallet) and native SOL transfers decoded from the newest 5 per wallet. Not full history, not token transfers, swaps or PnL.",
  };
}
