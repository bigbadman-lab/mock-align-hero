// Token Risk Analyst v1 — transparent, evidence-backed checklist of observable control and concentration
// indicators for one mint. Not a safety verdict: no score, no "safe"/"scam" labels. Reuses the Holder
// Intelligence collection (one fetch set; no repeated RPC calls).
import { collectHolderData, analyzeHolders, metadataFrom, HI_COMMITMENT } from "./holders.mjs";

export const TRA_SCHEMA = "mcpx.tool-execution.token-risk-analyst.v1";
export const TRA_TOOL_ID = "token_risk_analyst";
/** Deterministic concentration thresholds (percent of total onchain supply). */
export const THRESHOLDS = { largestAccountPct: 20, top10AccountsPct: 50 };

const parseState = (e) => { try { return JSON.parse(e.state ?? ""); } catch { return undefined; } };
const gte = (pct, t) => Number(pct.split(".")[0]) >= t; // integer part comparison; pct is an exact decimal string

/**
 * Token-2022 extension checks. `test(state)` → true observed / false not observed / undefined unknown.
 * Absent extension = not observed only when the extension list was completely decoded.
 */
const EXTENSIONS = [
  { id: "permanent_delegate", ext: "permanentDelegate", label: "Permanent delegate", meaning: "An address that can transfer or burn tokens from any account of this mint.", test: (s) => (s === undefined ? undefined : !!s?.delegate) },
  { id: "transfer_hook", ext: "transferHook", label: "Transfer hook", meaning: "A program that runs on every transfer and can make transfers fail.", test: (s) => (s === undefined ? undefined : !!s?.programId) },
  { id: "transfer_fee", ext: "transferFeeConfig", label: "Transfer fee", meaning: "A fee withheld from transfers, set by a fee authority.", test: () => true },
  { id: "default_frozen", ext: "defaultAccountState", label: "New accounts start frozen", meaning: "New token accounts are frozen until the freeze authority thaws them.", test: (s) => (s?.accountState === "frozen" ? true : s?.accountState === "initialized" ? false : undefined) },
  { id: "non_transferable", ext: "nonTransferable", label: "Non-transferable", meaning: "Tokens cannot be transferred between owners.", test: () => true },
  { id: "pausable", ext: "pausableConfig", label: "Pausable", meaning: "An authority can pause transfers, mints and burns.", test: () => true },
  { id: "mint_close_authority", ext: "mintCloseAuthority", label: "Mint close authority", meaning: "An address that can close the mint account once supply is zero.", test: (s) => (s === undefined ? undefined : !!s?.closeAuthority) },
];

/** Pure: checklist from collected data. Every item has state + evidence + explanation. */
export function buildChecklist(d, holders) {
  const f = d.facts;
  const items = [];
  const add = (id, label, state, evidence, meaning) => items.push({ id, label, state, evidence, meaning });
  add("mint_authority", "Mint authority", f.mintAuthority ? "observed" : "not_observed", f.mintAuthority, "An address that can create more tokens. Not observed = the field is empty onchain, so no new tokens can be minted.");
  add("freeze_authority", "Freeze authority", f.freezeAuthority ? "observed" : "not_observed", f.freezeAuthority, "An address that can freeze token accounts so they cannot move tokens.");
  for (const x of EXTENSIONS) {
    if (f.program !== "token-2022") { add(x.id, x.label, "not_applicable", null, `${x.meaning} Only Token-2022 mints have this extension.`); continue; }
    const e = (f.extensions ?? []).find((y) => y.name === x.ext);
    if (!e) { add(x.id, x.label, f.extensionsComplete ? "not_observed" : "unknown", null, x.meaning); continue; }
    const r = x.test(parseState(e));
    add(x.id, x.label, r === true ? "observed" : r === false ? "not_observed" : "unknown", e.state, x.meaning);
  }
  if (f.program === "token-2022") {
    const und = (f.extensions ?? []).filter((e) => !e.decoded).length;
    add("undecoded_extensions", "Extensions that could not be decoded", und > 0 || !f.extensionsComplete ? "observed" : "not_observed", und > 0 ? `${und} extension(s)` : null, "Extensions the RPC decoder could not read. Their effect is unknown.");
  } else add("undecoded_extensions", "Extensions that could not be decoded", "not_applicable", null, "Classic SPL Token mints have no extensions.");

  const c = holders?.concentration;
  const zero = d.supply?.raw === "0";
  const conc = (id, label, pct, t, meaning) => {
    if (zero) return add(id, label, "not_applicable", null, `${meaning} Supply is zero, so shares are undefined.`);
    if (!c || pct === null) return add(id, label, "unknown", null, `${meaning} The largest-accounts list was unavailable.`);
    add(id, label, gte(pct, t) ? "observed" : "not_observed", `${pct}% of total supply`, meaning);
  };
  conc("largest_account_concentration", `Largest token account holds ≥ ${THRESHOLDS.largestAccountPct}% of supply`, c?.largestAccountPct ?? null, THRESHOLDS.largestAccountPct, "One token account, not necessarily one person. Pools, exchanges and burn or vesting accounts can be the largest.");
  conc("top10_concentration", `Top 10 token accounts hold ≥ ${THRESHOLDS.top10AccountsPct}% of supply`, c?.top10AccountsPct ?? null, THRESHOLDS.top10AccountsPct, "Measured on the largest token accounts only.");
  return items;
}

export async function tokenRiskAnalyst({ mint, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const d = await collectHolderData({ mint, rpcUrl, fetchImpl, signal });
  return buildRiskResult(d, executionId, now);
}

export function buildRiskResult(d, executionId, now = () => new Date()) {
  const base = { schema: TRA_SCHEMA, executionId, toolId: TRA_TOOL_ID, network: "solana-mainnet", commitment: HI_COMMITMENT, mint: d.mint, observedAt: now().toISOString(), rpcCalls: d.calls.length, methods: [...new Set(d.calls)] };
  if (d.facts.status !== "mint") return { ...base, status: d.facts.status, program: d.facts.program ?? null, decimals: null, supply: null, metadata: null, checklist: [], concentration: null, summary: null, slots: { mint: d.accountSlot } };
  const holders = d.largest.status === "ok" ? analyzeHolders(d) : null;
  const checklist = buildChecklist(d, holders);
  const count = (s) => checklist.filter((i) => i.state === s).length;
  const summary = { observed: count("observed"), notObserved: count("not_observed"), unknown: count("unknown"), notApplicable: count("not_applicable"), complete: count("unknown") === 0, score: null };
  return {
    ...base, status: "mint", program: d.facts.program, decimals: d.facts.decimals, supply: d.supply, metadata: metadataFrom(d.facts),
    checklist, concentration: holders ? { ...holders.concentration, coverage: "largest_token_accounts", observedAccounts: holders.coverage.observedAccounts } : null,
    thresholds: THRESHOLDS, summary,
    slots: { mint: d.accountSlot, supply: d.supply.slot, largestAccounts: d.largest.slot },
  };
}
