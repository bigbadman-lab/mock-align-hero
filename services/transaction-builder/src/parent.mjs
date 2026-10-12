// Parent quote ($MCP) eligibility for create_v2 with a pump-coin quote. Uses the SDK's own admission
// checks (pumpQuoteReserves) against the real Global, plus MCPX rules: depth 0, not mayhem, program match.
import { pump, PROGRAMS } from "./sdk.mjs";

const ERR = [
  [pump.CurveDepthExceededError, "QUOTE_DEPTH_EXCEEDED"],
  [pump.QuoteCurveAwaitingMigrationError, "QUOTE_AWAITING_MIGRATION"],
  [pump.QuoteBondingCurveNotEligibleError, "QUOTE_INELIGIBLE"],
  [pump.QuoteReservesOutOfRangeError, "QUOTE_RESERVES_OUT_OF_RANGE"],
  [pump.QuotePoolNotFoundError, "PROTOCOL_ACCOUNT_MISSING"],
];

/**
 * @param p {{ global:any, quoteMint:string, quoteTokenProgram:import("@solana/web3.js").PublicKey|null,
 *   pumpQuote: { curve:any, accounts:any } | null }}
 */
export function assessParent(p) {
  const tp = p.quoteTokenProgram?.toBase58();
  if (!tp) return { ok: false, code: "PROTOCOL_ACCOUNT_MISSING", detail: "quote_mint_account" };
  const isSpl = tp === PROGRAMS.token.toBase58(), is22 = tp === PROGRAMS.token2022.toBase58();
  if (!isSpl && !is22) return { ok: false, code: "QUOTE_TOKEN_PROGRAM_MISMATCH" };
  if (!p.pumpQuote) return { ok: false, code: "QUOTE_INELIGIBLE", detail: "not_a_pump_coin" };
  const bc = p.pumpQuote.curve.bondingCurve;
  if (p.pumpQuote.curve.mint.toBase58() !== p.quoteMint) return { ok: false, code: "QUOTE_MINT_MISMATCH" };
  if (bc.isMayhemMode) return { ok: false, code: "QUOTE_MAYHEM_PROHIBITED" };
  if (bc.depth !== 0) return { ok: false, code: "QUOTE_ALREADY_PUMP_PAIRED" };
  let seed;
  try { seed = pump.pumpQuoteReserves(p.global, p.pumpQuote.curve); }
  catch (e) {
    for (const [cls, code] of ERR) if (cls && e instanceof cls) return { ok: false, code };
    return { ok: false, code: "QUOTE_INELIGIBLE", detail: "sdk_admission" };
  }
  const migrated = pump.isBondingCurveMigrated(bc);
  return {
    ok: true,
    scenario: `${migrated ? "migrated_pool" : "active_curve"}_${isSpl ? "spl" : "token2022"}`,
    childDepth: seed.depth,
    curve: p.pumpQuote.curve,
    accounts: p.pumpQuote.accounts ?? {},
  };
}
