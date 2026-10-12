// Token Scanner v1 — read-only facts about one SPL Token / Token-2022 mint account.
// Uses the RPC node's own jsonParsed mint decoder (the validator's official parser), not hand-rolled
// binary layouts. Unknown/unparseable extensions are reported as such, never as "none".
import { RpcError, rpcFetch, parseAddress, formatUnits, PROGRAMS } from "./inspect.mjs";

export const TS_SCHEMA = "mcpx.tool-execution.token-scanner.v1";
export const TS_TOOL_ID = "token_scanner";
export const TS_COMMITMENT = "confirmed";
const MAX_EXTENSIONS = 32;
const MAX_STATE_JSON = 600;

const isPk = (v) => typeof v === "string" && parseAddress(v) === v;
const auth = (v) => (v === null || v === undefined ? null : isPk(v) ? v : undefined);

function boundedState(state) {
  if (state === undefined) return null;
  let s; try { s = JSON.stringify(state); } catch { return null; }
  return s.length > MAX_STATE_JSON ? s.slice(0, MAX_STATE_JSON) + "…" : s;
}

/** Pure normalizer for getAccountInfo(jsonParsed) value. Returns { kind, ... }. */
export function normalizeMint(value) {
  if (value === null) return { status: "not_found" };
  if (!value || typeof value !== "object" || typeof value.owner !== "string") throw new RpcError("bad_response", "account shape");
  const program = value.owner === PROGRAMS.splToken ? "spl-token" : value.owner === PROGRAMS.token2022 ? "token-2022" : null;
  if (!program) return { status: "not_token_program", owner: isPk(value.owner) ? value.owner : null };
  const parsed = value.data?.parsed;
  if (!parsed || typeof parsed !== "object") return { status: "unparsed", program };
  if (parsed.type !== "mint") return { status: "not_a_mint", program, accountType: typeof parsed.type === "string" ? parsed.type.slice(0, 40) : null };
  const info = parsed.info ?? {};
  const supply = typeof info.supply === "string" && /^\d{1,20}$/.test(info.supply) ? info.supply.replace(/^0+(?=\d)/, "") : null;
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255 || supply === null || typeof info.isInitialized !== "boolean") throw new RpcError("bad_response", "mint fields");
  const mintAuthority = auth(info.mintAuthority), freezeAuthority = auth(info.freezeAuthority);
  if (mintAuthority === undefined || freezeAuthority === undefined) throw new RpcError("bad_response", "authority");
  let extensions = null, extensionsComplete = true;
  if (program === "token-2022") {
    const raw = Array.isArray(info.extensions) ? info.extensions : [];
    if (raw.length > MAX_EXTENSIONS) extensionsComplete = false;
    extensions = raw.slice(0, MAX_EXTENSIONS).map((e) => {
      const name = typeof e?.extension === "string" ? e.extension.slice(0, 60) : "unknown";
      const unparseable = name === "unparseableExtension" || name === "unknown";
      if (unparseable) extensionsComplete = false;
      return { name, decoded: !unparseable, state: unparseable ? null : boundedState(e.state) };
    });
  }
  return {
    status: "mint", program, isInitialized: info.isInitialized, decimals: info.decimals,
    supplyRaw: supply, supplyUi: formatUnits(supply, info.decimals), mintAuthority, freezeAuthority, extensions, extensionsComplete,
  };
}

/** Two bounded parallel reads: getAccountInfo (owner + parsed mint) and getTokenSupply (independent cross-check). */
export async function scanToken({ mint, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const addr = parseAddress(mint);
  if (!addr) throw new RpcError("invalid_input", "invalid mint");
  const [acct, sup] = await Promise.allSettled([
    rpcFetch(rpcUrl, "getAccountInfo", [addr, { commitment: TS_COMMITMENT, encoding: "jsonParsed" }], fetchImpl, signal),
    rpcFetch(rpcUrl, "getTokenSupply", [addr, { commitment: TS_COMMITMENT }], fetchImpl, signal),
  ]);
  if (acct.status === "rejected") throw acct.reason;
  const a = acct.value;
  if (!a || typeof a.context?.slot !== "number" || !("value" in a)) throw new RpcError("bad_response", "getAccountInfo missing context");
  const facts = normalizeMint(a.value);
  let supplyCheck = { status: "not_applicable", slot: null, supplyRaw: null, matches: null };
  if (facts.status === "mint") {
    const s = sup.status === "fulfilled" ? sup.value : null;
    const amt = s?.value?.amount;
    if (s && typeof s.context?.slot === "number" && typeof amt === "string" && /^\d{1,20}$/.test(amt)) {
      const raw = amt.replace(/^0+(?=\d)/, "");
      supplyCheck = { status: "ok", slot: s.context.slot, supplyRaw: raw, matches: raw === facts.supplyRaw };
    } else supplyCheck = { status: "unavailable", slot: null, supplyRaw: null, matches: null };
  }
  return {
    schema: TS_SCHEMA, executionId, toolId: TS_TOOL_ID, network: "solana-mainnet",
    source: "Solana mainnet via configured RPC (getAccountInfo jsonParsed + getTokenSupply)",
    commitment: TS_COMMITMENT, mint: addr, fetchedAt: now().toISOString(), accountSlot: a.context.slot,
    ...{ program: null, isInitialized: null, decimals: null, supplyRaw: null, supplyUi: null, mintAuthority: null, freezeAuthority: null, extensions: null, extensionsComplete: null, owner: null, accountType: null },
    ...facts, supplyCheck,
  };
}
