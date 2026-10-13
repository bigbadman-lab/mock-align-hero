// Onchain Report Builder v1 — deterministic report for one wallet OR one token mint, composed from
// existing MCPX tool functions in-process (no relay re-entry, no website quota). Fixed composition:
//   wallet → Wallet Inspector (required, 3 calls) + Account Checker (optional, 1 call)
//   token  → Token Scanner (required, 2 calls) + Supply Monitor (optional, 3 calls)
// One shared provider-call budget and one deadline for the whole report. No AI; no chain text copied in.
import { RpcError, parseAddress } from "./inspect.mjs";
import { inspectWallet, SCHEMA as WI_SCHEMA } from "./inspect.mjs";
import { checkAccount, AC_SCHEMA } from "./account.mjs";
import { scanToken, TS_SCHEMA } from "./scan.mjs";
import { monitorSupply, SM_SCHEMA } from "./supply.mjs";

export const ORB_SCHEMA = "mcpx.tool-execution.onchain-report.v1";
export const ORB_TOOL_ID = "onchain_report_builder";
export const CALL_BUDGET = 6;
export const REPORT_BUDGET_MS = 16_000;
const MAX_HOLDINGS = 10;

export const validInput = (i) => !!i && typeof i === "object" && !Array.isArray(i) && Object.keys(i).sort().join(",") === "target,targetType"
  && (i.targetType === "wallet" || i.targetType === "token") && parseAddress(i.target) === i.target;

const PLAN = {
  wallet: [{ tool: "wallet_inspector", schema: WI_SCHEMA, required: true, run: (a, o) => inspectWallet({ address: a, ...o }) }, { tool: "account_checker", schema: AC_SCHEMA, required: false, run: (a, o) => checkAccount({ address: a, ...o }) }],
  token: [{ tool: "token_scanner", schema: TS_SCHEMA, required: true, run: (a, o) => scanToken({ mint: a, ...o }) }, { tool: "supply_monitor", schema: SM_SCHEMA, required: false, run: (a, o) => monitorSupply({ mint: a, ...o }) }],
};

function walletFindings(wi, ac) {
  const f = [];
  f.push(wi.solBalance ? { id: "sol_balance", text: `SOL balance: ${wi.solBalance.solUi} SOL.`, evidence: `getBalance @ slot ${wi.sourceSlots.balance}` } : { id: "sol_balance", text: "SOL balance could not be read.", evidence: null });
  const holdings = [...wi.tokenHoldings].slice(0, MAX_HOLDINGS).map((h) => ({ mint: h.mint, amountUi: h.amountUi, tokenAccounts: h.tokenAccounts }));
  f.push({ id: "token_holdings", text: wi.partial ? `${wi.tokenHoldings.length} token mints found, but some token programs could not be read — the list may be incomplete.` : `${wi.tokenHoldings.length} token mints with token accounts (SPL Token + Token-2022).`, evidence: "getTokenAccountsByOwner (both programs)" });
  if (ac) f.push(ac.exists ? { id: "account", text: `Account exists; owning program classification: ${ac.classification}${ac.executable ? " (executable program)" : ""}.`, evidence: `getAccountInfo @ slot ${ac.slot}` } : { id: "account", text: "No account exists at this address.", evidence: `getAccountInfo @ slot ${ac.slot}` });
  return { findings: f, holdings };
}

function tokenFindings(ts, sm) {
  const f = [];
  if (ts.status !== "mint") return { findings: [{ id: "not_mint", text: `Not a token mint (${ts.status}).`, evidence: `getAccountInfo @ slot ${ts.accountSlot}` }] };
  f.push({ id: "program", text: `Token program: ${ts.program}; decimals ${ts.decimals}.`, evidence: `getAccountInfo @ slot ${ts.accountSlot}` });
  f.push({ id: "supply", text: `Total onchain supply: ${ts.supplyUi}.`, evidence: ts.supplyCheck.status === "ok" ? `getTokenSupply @ slot ${ts.supplyCheck.slot}` : "mint account" });
  f.push({ id: "mint_authority", text: ts.mintAuthority ? `Mint authority is set (${ts.mintAuthority}): more tokens can be created.` : "Mint authority is empty: no more tokens can be minted.", evidence: "mint account" });
  f.push({ id: "freeze_authority", text: ts.freezeAuthority ? `Freeze authority is set (${ts.freezeAuthority}): token accounts can be frozen.` : "Freeze authority is empty.", evidence: "mint account" });
  if (ts.program === "token-2022") f.push({ id: "extensions", text: `${(ts.extensions ?? []).length} Token-2022 extension(s)${ts.extensionsComplete ? "" : "; some could not be decoded — effect unknown"}: ${(ts.extensions ?? []).map((e) => e.name.replace(/[^A-Za-z0-9]/g, "")).join(", ") || "none"}.`, evidence: "mint account" });
  if (sm?.distribution?.status === "ok") f.push({ id: "largest_accounts", text: `The ${sm.distribution.accounts.length} largest token accounts hold ${sm.distribution.returnedSharePct ?? "N/A"}% of total supply (token accounts, not holders).`, evidence: `getTokenLargestAccounts @ slot ${sm.distribution.slot}` });
  else if (sm) f.push({ id: "largest_accounts", text: "Largest token accounts could not be read; concentration is unknown.", evidence: null });
  return { findings: f };
}

export async function buildReport({ targetType, target, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date(), budgetMs = REPORT_BUDGET_MS }) {
  if (!validInput({ targetType, target })) throw new RpcError("invalid_input", "invalid target");
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), budgetMs);
  signal?.addEventListener("abort", () => ctrl.abort());
  let calls = 0;
  const budgeted = (u, init) => { if (++calls > CALL_BUDGET) return Promise.reject(new Error("budget")); return fetchImpl(u, init); };
  const started = Date.now();
  try {
    const plan = PLAN[targetType];
    const res = await Promise.allSettled(plan.map((p) => p.run(target, { rpcUrl, executionId, fetchImpl: budgeted, signal: ctrl.signal, now })));
    const components = plan.map((p, i) => ({ tool: p.tool, schema: p.schema, required: p.required, status: res[i].status === "fulfilled" ? (res[i].value.partial ? "partial" : "ok") : "failed", error: res[i].status === "rejected" ? (res[i].reason instanceof RpcError ? res[i].reason.kind : "internal") : null }));
    const req = res[plan.findIndex((p) => p.required)];
    if (req.status === "rejected") throw req.reason instanceof RpcError ? req.reason : new RpcError("internal", "required component"); // fail closed
    const opt = res.find((r, i) => !plan[i].required);
    const body = targetType === "wallet" ? walletFindings(req.value, opt.status === "fulfilled" ? opt.value : null) : tokenFindings(req.value, opt.status === "fulfilled" ? opt.value : null);
    const partial = components.some((c) => c.status !== "ok");
    return {
      schema: ORB_SCHEMA, executionId, toolId: ORB_TOOL_ID, network: "solana-mainnet", targetType, target,
      generatedAt: now().toISOString(), status: partial ? "partial" : "complete", components, ...body,
      limitations: [
        "A point-in-time report generated at the time shown, not a history or a guarantee.",
        targetType === "wallet" ? "Holdings are token accounts the wallet owns now; no prices, PnL or past activity." : "Describes onchain settings only; never a safety, fraud or investment verdict.",
        ...(partial ? ["PARTIAL: at least one component failed or was incomplete — missing parts are unknown, not zero."] : []),
      ],
      usage: { rpcCalls: calls, callBudget: CALL_BUDGET, ms: Date.now() - started },
    };
  } finally { clearTimeout(kill); }
}
