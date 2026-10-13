// Holder Intelligence v1 — one user-triggered, read-only view of a mint's LARGEST TOKEN ACCOUNTS
// and the owner addresses behind them. Not a complete holder index: getTokenLargestAccounts returns at
// most 20 accounts, so unique-holder counts are never derived. Never reads the rewards holder index.
// Bounded: at most 5 RPC calls (3 parallel + 2 sequential lookups of ≤20 addresses each).
import { PublicKey } from "@solana/web3.js";
import { RpcError, rpcFetch, parseAddress, formatUnits } from "./inspect.mjs";
import { normalizeMint } from "./scan.mjs";
import { percentOf, MAX_LARGEST } from "./supply.mjs";

export const HI_SCHEMA = "mcpx.tool-execution.holder-intelligence.v1";
export const HI_TOOL_ID = "holder_intelligence";
export const HI_COMMITMENT = "confirmed";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MAX_RPC_CALLS = 5;

const u64 = (v) => (typeof v === "string" && /^\d{1,20}$/.test(v) ? v.replace(/^0+(?=\d)/, "") : null);
const kindOf = (e) => (e instanceof RpcError ? e.kind : "internal");
const sumRaw = (xs) => xs.reduce((t, x) => t + BigInt(x.raw), 0n).toString();
const onCurve = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return null; } };

/** Token-2022 tokenMetadata extension name/symbol, only when decoded; otherwise null (unknown, not absent). */
export function metadataFrom(facts) {
  if (facts.program !== "token-2022") return { status: "not_read", name: null, symbol: null, source: null };
  const ext = (facts.extensions ?? []).find((e) => e.name === "tokenMetadata");
  if (!ext) return { status: facts.extensionsComplete ? "none" : "unknown", name: null, symbol: null, source: null };
  try {
    const s = JSON.parse(ext.state ?? "");
    const name = typeof s?.name === "string" ? s.name.slice(0, 64) : null;
    const symbol = typeof s?.symbol === "string" ? s.symbol.slice(0, 16) : null;
    return { status: "ok", name, symbol, source: "token-2022 tokenMetadata extension" };
  } catch { return { status: "unknown", name: null, symbol: null, source: null }; }
}

/**
 * Shared, bounded data collection used by Holder Intelligence AND Token Risk Analyst (one fetch set per run).
 * Returns facts + supply + largest accounts + owner resolution, each with its own slot and status.
 */
export async function collectHolderData({ mint, rpcUrl, fetchImpl = fetch, signal }) {
  const addr = parseAddress(mint);
  if (!addr) throw new RpcError("invalid_input", "invalid mint");
  const c = { commitment: HI_COMMITMENT };
  const calls = [];
  const rpc = (method, params) => { calls.push(method); if (calls.length > MAX_RPC_CALLS) throw new RpcError("internal", "call budget"); return rpcFetch(rpcUrl, method, params, fetchImpl, signal); };
  const [acct, sup, big] = await Promise.allSettled([
    rpc("getAccountInfo", [addr, { ...c, encoding: "jsonParsed" }]),
    rpc("getTokenSupply", [addr, c]),
    rpc("getTokenLargestAccounts", [addr, c]),
  ]);
  if (acct.status === "rejected") throw acct.reason;
  const a = acct.value;
  if (!a || typeof a.context?.slot !== "number" || !("value" in a)) throw new RpcError("bad_response", "getAccountInfo missing context");
  const facts = normalizeMint(a.value);
  const out = { mint: addr, accountSlot: a.context.slot, facts, supply: null, largest: null, owners: null, calls };
  if (facts.status !== "mint") return out;

  if (sup.status === "rejected") throw sup.reason; // never a fake zero supply
  const s = sup.value;
  const raw = u64(s?.value?.amount);
  if (!s || typeof s.context?.slot !== "number" || raw === null || s.value.decimals !== facts.decimals) throw new RpcError("bad_response", "supply inconsistent");
  out.supply = { raw, ui: formatUnits(raw, facts.decimals), slot: s.context.slot };

  if (big.status === "rejected") { out.largest = { status: "unavailable", reason: kindOf(big.reason), slot: null, list: [] }; return out; }
  const b = big.value;
  const list = Array.isArray(b?.value) ? b.value : null;
  const valid = list && typeof b.context?.slot === "number" && list.length <= MAX_LARGEST
    && list.every((x) => parseAddress(x?.address) && u64(x?.amount) !== null && x.decimals === facts.decimals)
    && new Set(list.map((x) => x.address)).size === list.length;
  if (!valid) { out.largest = { status: "unavailable", reason: "bad_response", slot: null, list: [] }; return out; }
  out.largest = { status: "ok", reason: null, slot: b.context.slot, list: list.map((x) => ({ address: x.address, raw: u64(x.amount) })) };
  if (list.length === 0) { out.owners = { status: "not_applicable", reason: null, slot: null, ownerSlot: null, byAccount: {}, ownerInfo: {} }; return out; }

  // Owner resolution: decode each listed token account; the token account's `owner` field is the owner authority.
  let accInfo;
  try { accInfo = await rpc("getMultipleAccounts", [out.largest.list.map((x) => x.address), { ...c, encoding: "jsonParsed" }]); }
  catch (e) { out.owners = { status: "unavailable", reason: kindOf(e), slot: null, ownerSlot: null, byAccount: {}, ownerInfo: {} }; return out; }
  const vals = Array.isArray(accInfo?.value) && typeof accInfo.context?.slot === "number" && accInfo.value.length === list.length ? accInfo.value : null;
  if (!vals) { out.owners = { status: "unavailable", reason: "bad_response", slot: null, ownerSlot: null, byAccount: {}, ownerInfo: {} }; return out; }
  const byAccount = {};
  out.largest.list.forEach((x, i) => {
    const v = vals[i];
    if (v === null) { byAccount[x.address] = { status: "missing", owner: null, state: null }; return; } // closed since the list was read
    const info = v?.data?.parsed?.type === "account" ? v.data.parsed.info : null;
    if (!info || info.mint !== addr || !parseAddress(info.owner)) { byAccount[x.address] = { status: "unresolved", owner: null, state: null }; return; }
    byAccount[x.address] = { status: "resolved", owner: info.owner, state: ["initialized", "frozen"].includes(info.state) ? info.state : null };
  });
  out.owners = { status: "ok", reason: null, slot: accInfo.context.slot, ownerSlot: null, byAccount, ownerInfo: {} };

  // Classify each owner address by the program that owns it (system account vs program-owned vs none).
  const owners = [...new Set(Object.values(byAccount).filter((r) => r.owner).map((r) => r.owner))];
  if (owners.length === 0) return out;
  try {
    const oi = await rpc("getMultipleAccounts", [owners, { ...c, encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    const ov = Array.isArray(oi?.value) && typeof oi.context?.slot === "number" && oi.value.length === owners.length ? oi.value : null;
    if (!ov) throw new RpcError("bad_response", "owner lookup");
    out.owners.ownerSlot = oi.context.slot;
    owners.forEach((o, i) => {
      const v = ov[i];
      const prog = v && typeof v.owner === "string" && parseAddress(v.owner) ? v.owner : null;
      out.owners.ownerInfo[o] = { kind: v === null ? "no_account" : prog === SYSTEM_PROGRAM ? "system_account" : prog ? "program_owned" : "unknown", program: prog, onCurve: onCurve(o) };
    });
  } catch (e) {
    out.owners.ownerLookup = kindOf(e);
    owners.forEach((o) => { out.owners.ownerInfo[o] = { kind: "unknown", program: null, onCurve: onCurve(o) }; });
  }
  return out;
}

/** Pure: concentration of the observed accounts and owners relative to total supply. */
export function concentration(accounts, ownersAgg, supplyRaw) {
  const top = (n) => (accounts.length >= 1 ? percentOf(sumRaw(accounts.slice(0, n)), supplyRaw) : null);
  return {
    denominator: "total onchain supply",
    largestAccountPct: accounts.length ? percentOf(accounts[0].raw, supplyRaw) : null,
    top5AccountsPct: top(5), top10AccountsPct: top(10), top20AccountsPct: top(20),
    largestObservedOwnerPct: ownersAgg.length ? percentOf(ownersAgg[0].raw, supplyRaw) : null,
  };
}

/** Pure: build the Holder Intelligence analysis from collected data (also reused by Token Risk Analyst). */
export function analyzeHolders(d) {
  const { facts, supply, largest, owners } = d;
  const dec = facts.decimals;
  const accounts = largest.list.map((x) => {
    const o = owners?.byAccount?.[x.address] ?? { status: "unresolved", owner: null, state: null };
    return { address: x.address, raw: x.raw, ui: formatUnits(x.raw, dec), sharePct: percentOf(x.raw, supply.raw), owner: o.owner, ownerStatus: owners?.status === "ok" ? o.status : "unresolved", state: o.state };
  });
  const agg = new Map();
  for (const a of accounts) {
    if (!a.owner) continue;
    const cur = agg.get(a.owner) ?? { owner: a.owner, accounts: 0, raw: 0n };
    cur.accounts += 1; cur.raw += BigInt(a.raw); agg.set(a.owner, cur);
  }
  const ownersAgg = [...agg.values()]
    .map((o) => { const info = owners?.ownerInfo?.[o.owner] ?? { kind: "unknown", program: null, onCurve: null }; const r = o.raw.toString(); return { owner: o.owner, tokenAccounts: o.accounts, raw: r, ui: formatUnits(r, dec), sharePct: percentOf(r, supply.raw), ownerKind: info.kind, ownerProgram: info.program, onCurve: info.onCurve }; })
    .sort((x, y) => (BigInt(y.raw) > BigInt(x.raw) ? 1 : BigInt(y.raw) < BigInt(x.raw) ? -1 : x.owner.localeCompare(y.owner)));
  const resolved = accounts.filter((a) => a.ownerStatus === "resolved").length;
  const observedRaw = sumRaw(accounts);
  return {
    accounts, owners: ownersAgg,
    concentration: largest.status === "ok" ? concentration(accounts, ownersAgg, supply.raw) : null,
    coverage: {
      population: "largest_token_accounts",
      populationNote: "Only the largest token accounts the RPC returns (max 20). Not every holder; unique-holder count is not enumerated.",
      maxAccounts: MAX_LARGEST,
      observedAccounts: accounts.length,
      observedRaw, observedUi: formatUnits(observedRaw, dec), observedSharePct: percentOf(observedRaw, supply.raw),
      ownersResolved: resolved, ownersUnresolved: accounts.length - resolved,
      ownerAggregationScope: "within observed accounts only",
      completeHolderSet: false, uniqueHolderCount: null,
    },
  };
}

export async function holderIntelligence({ mint, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const d = await collectHolderData({ mint, rpcUrl, fetchImpl, signal });
  return buildHolderResult(d, executionId, now);
}

export function buildHolderResult(d, executionId, now = () => new Date()) {
  const base = { schema: HI_SCHEMA, executionId, toolId: HI_TOOL_ID, network: "solana-mainnet", commitment: HI_COMMITMENT, mint: d.mint, observedAt: now().toISOString(), rpcCalls: d.calls.length, methods: [...new Set(d.calls)] };
  if (d.facts.status !== "mint") return { ...base, status: d.facts.status, program: d.facts.program ?? null, decimals: null, supply: null, metadata: null, distribution: null, slots: { mint: d.accountSlot }, partial: false, warnings: [] };
  const warnings = [];
  if (d.largest.status !== "ok") warnings.push({ part: "largest_accounts", kind: d.largest.reason });
  if (d.owners && d.owners.status === "unavailable") warnings.push({ part: "owner_resolution", kind: d.owners.reason });
  if (d.owners?.ownerLookup) warnings.push({ part: "owner_classification", kind: d.owners.ownerLookup });
  const missing = d.owners?.byAccount ? Object.values(d.owners.byAccount).filter((r) => r.status !== "resolved").length : 0;
  if (missing > 0) warnings.push({ part: "owner_resolution", kind: "some_unresolved" });
  const distribution = d.largest.status === "ok" ? { status: "ok", reason: null, ...analyzeHolders(d) } : { status: "unavailable", reason: d.largest.reason, accounts: [], owners: [], concentration: null, coverage: null };
  const slots = { mint: d.accountSlot, supply: d.supply.slot, largestAccounts: d.largest.slot, tokenAccounts: d.owners?.slot ?? null, ownerAccounts: d.owners?.ownerSlot ?? null };
  const present = Object.values(slots).filter((x) => x !== null);
  return {
    ...base, status: "mint", program: d.facts.program, decimals: d.facts.decimals, supply: d.supply, metadata: metadataFrom(d.facts),
    distribution, slots, sameSlot: present.every((x) => x === present[0]), partial: warnings.length > 0, warnings,
  };
}
