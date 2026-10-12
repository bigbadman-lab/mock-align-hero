// Whale Watch v1 — on-demand, bounded sample of recent NATIVE SOL transfers for one address.
// Proven transfers only: successful System Program transfer / transferWithSeed instructions
// (outer and inner/CPI) decoded by the RPC node's jsonParsed parser, where the address is sender or recipient.
// Balance deltas, fees, rent, wrapped SOL, swaps and token transfers are never counted.
import { RpcError, rpcFetch, parseAddress, formatUnits } from "./inspect.mjs";

export const WW_SCHEMA = "mcpx.tool-execution.whale-watch.v1";
export const WW_TOOL_ID = "whale_watch";
export const WW_COMMITMENT = "finalized";
export const SIGNATURE_LIMIT = 20;
export const DETAIL_LIMIT = 10;
export const DETAIL_CONCURRENCY = 2;
export const RUN_BUDGET_MS = 16_000; // inside the worker's 20 s overall request deadline
export const THRESHOLDS = ["100000000", "1000000000", "10000000000", "100000000000"]; // 0.1 / 1 / 10 / 100 SOL
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TRANSFER_TYPES = new Set(["transfer", "transferWithSeed"]);

export const parseThreshold = (v) => (typeof v === "string" && THRESHOLDS.includes(v) ? v : null);
export const validInput = (i) => !!i && Object.keys(i).sort().join(",") === "address,minLamports" && !!parseAddress(i.address) && !!parseThreshold(i.minLamports);

/** Extracts proven native SOL transfers involving `address`. Returns { transfers, undecodable }. */
export function extractTransfers(tx, address, signature) {
  const transfers = [];
  let undecodable = 0;
  const visit = (ix, outer, inner) => {
    if (!ix || typeof ix !== "object") { undecodable++; return; }
    if (ix.programId !== SYSTEM_PROGRAM) return; // other programs are out of scope, not "unknown"
    if (!ix.parsed || typeof ix.parsed !== "object") { undecodable++; return; }
    if (!TRANSFER_TYPES.has(ix.parsed.type)) return; // createAccount, assign, etc. are not transfers
    const { source, destination, lamports } = ix.parsed.info ?? {};
    if (!parseAddress(source) || !parseAddress(destination) || !Number.isSafeInteger(lamports) || lamports < 0) { undecodable++; return; }
    if (source !== address && destination !== address) return;
    transfers.push({
      signature, outerIndex: outer, innerIndex: inner, slot: tx.slot,
      blockTime: Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null,
      from: source, to: destination, lamports: String(lamports), sol: formatUnits(String(lamports), 9),
      direction: source === destination ? "SELF" : source === address ? "OUT" : "IN",
    });
  };
  const outer = tx.transaction?.message?.instructions;
  if (!Array.isArray(outer)) return { transfers: [], undecodable: 1 };
  outer.forEach((ix, i) => visit(ix, i, null));
  const inner = tx.meta?.innerInstructions;
  if (inner !== undefined && inner !== null) {
    if (!Array.isArray(inner)) undecodable++;
    else for (const group of inner) {
      if (!Number.isInteger(group?.index) || !Array.isArray(group.instructions)) { undecodable++; continue; }
      group.instructions.forEach((ix, j) => visit(ix, group.index, j));
    }
  }
  return { transfers, undecodable };
}

export async function watchWhales({ address, minLamports, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date(), budgetMs = RUN_BUDGET_MS }) {
  const addr = parseAddress(address);
  const min = parseThreshold(minLamports);
  if (!addr || !min) throw new RpcError("invalid_input", "invalid input");
  const deadline = Date.now() + budgetMs;
  const sigs = await rpcFetch(rpcUrl, "getSignaturesForAddress", [addr, { limit: SIGNATURE_LIMIT, commitment: WW_COMMITMENT }], fetchImpl, signal);
  if (!Array.isArray(sigs) || sigs.length > SIGNATURE_LIMIT || !sigs.every((s) => typeof s?.signature === "string" && s.signature.length <= 88 && Number.isSafeInteger(s.slot))) throw new RpcError("bad_response", "signatures shape");

  const targets = sigs.slice(0, DETAIL_LIMIT);
  const outcomes = new Array(targets.length).fill(null);
  let next = 0;
  const workerLoop = async () => {
    while (next < targets.length) {
      const i = next++;
      if (Date.now() >= deadline || signal?.aborted) { outcomes[i] = { kind: "budget" }; continue; }
      const s = targets[i];
      try {
        const tx = await rpcFetch(rpcUrl, "getTransaction", [s.signature, { commitment: WW_COMMITMENT, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], fetchImpl, signal);
        if (tx === null) outcomes[i] = { kind: "unavailable" };
        else if (!tx.meta || typeof tx.meta !== "object") outcomes[i] = { kind: "unverified" };
        else if (tx.meta.err !== null) outcomes[i] = { kind: "failed" }; // failed tx: nothing moved by its instructions
        else { const r = extractTransfers(tx, addr, s.signature); outcomes[i] = { kind: r.undecodable ? "partial" : "ok", ...r }; }
      } catch (e) {
        outcomes[i] = { kind: e instanceof RpcError && e.kind === "unsupported_version" ? "unsupported_version" : "unavailable" };
      }
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, workerLoop));

  const minBig = BigInt(min);
  const count = (k) => outcomes.filter((o) => o.kind === k).length;
  const all = outcomes.flatMap((o) => o.transfers ?? []);
  const seen = new Set();
  const transfers = all.filter((t) => BigInt(t.lamports) >= minBig).filter((t) => {
    const key = `${t.signature}:${t.outerIndex}:${t.innerIndex ?? "-"}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => b.slot - a.slot || targets.findIndex((s) => s.signature === a.signature) - targets.findIndex((s) => s.signature === b.signature) || a.outerIndex - b.outerIndex || (a.innerIndex ?? -1) - (b.innerIndex ?? -1));

  const coverage = {
    signaturesSeen: sigs.length,
    transactionsAttempted: outcomes.filter((o) => o.kind !== "budget").length,
    transactionsDecoded: count("ok") + count("partial"),
    failedTransactions: count("failed"),
    unavailableTransactions: count("unavailable") + count("unverified"),
    unsupportedVersion: count("unsupported_version"),
    partiallyDecoded: count("partial"),
    truncatedByBudget: count("budget"),
    notInspected: Math.max(0, sigs.length - targets.length),
  };
  const complete = coverage.unavailableTransactions === 0 && coverage.unsupportedVersion === 0 && coverage.partiallyDecoded === 0 && coverage.truncatedByBudget === 0;
  return {
    schema: WW_SCHEMA, executionId, toolId: WW_TOOL_ID, network: "solana-mainnet", commitment: WW_COMMITMENT,
    address: addr, minLamports: min, minSol: formatUnits(min, 9), fetchedAt: now().toISOString(),
    newestSlot: sigs[0]?.slot ?? null, oldestInspectedSlot: targets.length ? targets[targets.length - 1].slot : null,
    coverage, complete, transfers: transfers.slice(0, 200),
  };
}
