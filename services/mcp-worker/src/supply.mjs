// Supply Monitor v1 — one user-triggered snapshot: total supply + up to 20 largest TOKEN ACCOUNTS.
// Token accounts are not holders. Total supply is not circulating supply. No history, no alerts.
import { RpcError, rpcFetch, parseAddress, formatUnits } from "./inspect.mjs";
import { normalizeMint } from "./scan.mjs";

export const SM_SCHEMA = "mcpx.tool-execution.supply-monitor.v1";
export const SM_TOOL_ID = "supply_monitor";
export const SM_COMMITMENT = "confirmed";
export const MAX_LARGEST = 20;
export const PCT_DECIMALS = 4; // percentages truncated (floored) to 4 decimal places

const u64 = (v) => (typeof v === "string" && /^\d{1,20}$/.test(v) ? v.replace(/^0+(?=\d)/, "") : null);

/** Exact percentage of part/total as a decimal string, floored to PCT_DECIMALS; null when total is 0. */
export function percentOf(part, total) {
  const t = BigInt(total);
  if (t === 0n) return null;
  const scaled = (BigInt(part) * 100n * 10n ** BigInt(PCT_DECIMALS)) / t;
  return formatUnits(scaled.toString(), PCT_DECIMALS);
}

/** Three bounded parallel reads: getAccountInfo (mint check), getTokenSupply, getTokenLargestAccounts. */
export async function monitorSupply({ mint, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const addr = parseAddress(mint);
  if (!addr) throw new RpcError("invalid_input", "invalid mint");
  const c = { commitment: SM_COMMITMENT };
  const [acct, sup, big] = await Promise.allSettled([
    rpcFetch(rpcUrl, "getAccountInfo", [addr, { ...c, encoding: "jsonParsed" }], fetchImpl, signal),
    rpcFetch(rpcUrl, "getTokenSupply", [addr, c], fetchImpl, signal),
    rpcFetch(rpcUrl, "getTokenLargestAccounts", [addr, c], fetchImpl, signal),
  ]);
  if (acct.status === "rejected") throw acct.reason;
  const a = acct.value;
  if (!a || typeof a.context?.slot !== "number" || !("value" in a)) throw new RpcError("bad_response", "getAccountInfo missing context");
  const facts = normalizeMint(a.value);
  const base = { schema: SM_SCHEMA, executionId, toolId: SM_TOOL_ID, network: "solana-mainnet", commitment: SM_COMMITMENT, mint: addr, observedAt: now().toISOString(), accountSlot: a.context.slot };
  if (facts.status !== "mint") {
    return { ...base, status: facts.status, program: facts.program ?? null, decimals: null, supply: null, distribution: null };
  }
  // Supply is mandatory: without a verified supply there is no result (never a fake zero).
  if (sup.status === "rejected") throw sup.reason;
  const s = sup.value;
  const raw = u64(s?.value?.amount);
  if (!s || typeof s.context?.slot !== "number" || raw === null || s.value.decimals !== facts.decimals) throw new RpcError("bad_response", "supply inconsistent");
  const supply = { raw, ui: formatUnits(raw, facts.decimals), slot: s.context.slot };

  let distribution;
  if (big.status === "rejected") {
    const kind = big.reason instanceof RpcError ? big.reason.kind : "internal";
    distribution = { status: "unavailable", reason: kind, slot: null, accounts: [], returnedTotalRaw: null, returnedTotalUi: null, returnedSharePct: null };
  } else {
    const b = big.value;
    const list = Array.isArray(b?.value) ? b.value : null;
    const valid = list && typeof b.context?.slot === "number" && list.length <= MAX_LARGEST
      && list.every((x) => parseAddress(x?.address) && u64(x?.amount) !== null && x.decimals === facts.decimals);
    if (!valid) {
      distribution = { status: "unavailable", reason: "bad_response", slot: null, accounts: [], returnedTotalRaw: null, returnedTotalUi: null, returnedSharePct: null };
    } else {
      let total = 0n;
      const accounts = list.map((x) => { const r = u64(x.amount); total += BigInt(r); return { address: x.address, raw: r, ui: formatUnits(r, facts.decimals), sharePct: percentOf(r, raw) }; });
      distribution = { status: "ok", reason: null, slot: b.context.slot, accounts, returnedTotalRaw: total.toString(), returnedTotalUi: formatUnits(total.toString(), facts.decimals), returnedSharePct: percentOf(total.toString(), raw) };
    }
  }
  const slots = [a.context.slot, supply.slot, distribution.slot].filter((x) => x !== null);
  return {
    ...base, status: "mint", program: facts.program, decimals: facts.decimals, supply, distribution,
    sameSlot: slots.every((x) => x === slots[0]),
    partial: distribution.status !== "ok",
  };
}
