// Phase 05-F (replacement) — single-deployer-wallet native $MCP rewards. DRY-RUN ONLY. Pure; no I/O, no keys.
//
// Model: $MCP is launched manually in the Pump.fun UI (regular SOL-paired coin, holder rewards + mayhem off). Creator
// fees are collected to ONE dedicated deployer wallet, which is also the only future rewards signer. No onchain
// 60/40 fee sharing. MCPX's ledger splits each verified, finalized collection 30 (holder SOL) / 30 (buyback) / 40 (ops).
//
// Income evidence = 05-B single-recipient self-CPI collect events only (decodeFeeEvents). The 05-C two-recipient
// sharing decoder is never used here. Wallet balance increases are never income.
import { epochStart } from "./epochs";
import { WSOL_MINT, type FeeEvidence } from "./pump-events";
import type { Receipt, Store } from "./processor";

export const NATIVE_SPLIT_BPS = { holderSol: 3000n, buyback: 3000n, operations: 4000n } as const;
const DENOM = 10_000n;

/**
 * Rounding policy (deterministic, documented): holder SOL and buyback each get floor(amount*3000/10000);
 * operations gets the exact remainder (0–2 lamports above its 40%). Sum always equals the receipt exactly.
 */
export function split303040(amount: bigint) {
  if (amount <= 0n || amount >= 1n << 64n) throw new Error("amount_out_of_range");
  const solBudget = (amount * NATIVE_SPLIT_BPS.holderSol) / DENOM;
  const buybackBudget = (amount * NATIVE_SPLIT_BPS.buyback) / DENOM;
  const operations = amount - solBudget - buybackBudget;
  return { solBudget, buybackBudget, operations };
}

export type SingleWalletConfig = { mint: string | null; deployerWallet: string | null; childFeeWallets: readonly string[] };

/**
 * Provenance of the deployer wallet's creator fees. Pump creator vaults pool fees across every coin a creator made and
 * collect events carry no mint, so attribution is only sound if the deployer created $MCP and nothing else.
 * `createdMints === null` means the creator index could not be read → UNKNOWN, never assumed clean.
 */
export type Provenance = { createdMints: readonly string[] | null };

export type Attribution =
  | { kind: "ATTRIBUTED"; receipt: Receipt }
  | { kind: "BLOCKED"; reason: string };

export function attributeCreatorFee(cfg: SingleWalletConfig, ev: FeeEvidence, finalized: boolean, prov: Provenance): Attribution {
  if (!cfg.mint) return { kind: "BLOCKED", reason: "NATIVE_MINT_UNSET" };
  if (!cfg.deployerWallet) return { kind: "BLOCKED", reason: "DEPLOYER_WALLET_UNSET" };
  if (cfg.childFeeWallets.includes(cfg.deployerWallet)) return { kind: "BLOCKED", reason: "DEPLOYER_IS_CHILD_FEE_WALLET" };
  if (!finalized) return { kind: "BLOCKED", reason: "not_finalized" };
  if (ev.blockTime === null) return { kind: "BLOCKED", reason: "block_time_unknown" };
  if (ev.recipient !== cfg.deployerWallet) return { kind: "BLOCKED", reason: "recipient_not_deployer" };
  if (prov.createdMints === null) return { kind: "BLOCKED", reason: "PROVENANCE_UNKNOWN" };
  if (prov.createdMints.length !== 1 || prov.createdMints[0] !== cfg.mint) return { kind: "BLOCKED", reason: "DEPLOYER_CREATED_OTHER_COINS" };
  if (ev.source === "PUMP_CURVE_COLLECT") {
    if (ev.asset !== "SOL") return { kind: "BLOCKED", reason: "non_sol_quote" };
  } else if (ev.source === "PUMP_AMM_COLLECT_COIN_CREATOR") {
    // PumpSwap pays WSOL into a token account. Only accept it when that account is the deployer's WSOL ATA,
    // supplied by the caller from a finalized account read (unwrap is a separate future step, cost from ops).
    if (ev.asset !== "WSOL" || !ev.extra["destinationTokenAccount"]) return { kind: "BLOCKED", reason: "wsol_destination_unknown" };
    if (ev.extra["verifiedDestinationOwner"] !== cfg.deployerWallet || ev.extra["verifiedDestinationMint"] !== WSOL_MINT)
      return { kind: "BLOCKED", reason: "wsol_destination_not_verified" };
  } else return { kind: "BLOCKED", reason: "unsupported_source" };
  if (ev.amount <= 0n) return { kind: "BLOCKED", reason: "zero_amount" };
  const s = split303040(ev.amount);
  return { kind: "ATTRIBUTED", receipt: {
    key: `${ev.signature}:${ev.ixIndex}:${ev.eventIndex}`, signature: ev.signature, slot: ev.slot, blockTime: ev.blockTime,
    window: epochStart(ev.blockTime), rewardsLamports: s.solBudget + s.buybackBudget, operationsLamports: s.operations,
    solBudget: s.solBudget, buybackBudget: s.buybackBudget } };
}

/** Durable ingest through the 05-E store (Postgres in the worker): idempotent by (signature, ix, event). */
export async function ingestCreatorFee(store: Store, cfg: SingleWalletConfig, ev: FeeEvidence, finalized: boolean, prov: Provenance) {
  const a = attributeCreatorFee(cfg, ev, finalized, prov);
  if (a.kind === "BLOCKED") return { kind: "REJECTED" as const, reason: a.reason };
  if (!(await store.putReceipt(a.receipt))) return { kind: "DUPLICATE" as const };
  const wm = await store.watermark();
  return { kind: (wm !== null && a.receipt.window <= wm ? "LATE_ADJUSTMENT" : "CREDITED") as "LATE_ADJUSTMENT" | "CREDITED" };
}

/**
 * Spend guard for the single wallet. Operator gas top-ups and other deposits are never revenue; they only add headroom.
 * Spending stops unless the finalized balance covers every reserved bucket plus the proposed spend and its costs, and
 * costs fit the bounded ops cost budget (costs never reduce holder entitlements).
 */
export function checkSpendable(x: {
  finalizedBalance: bigint | null; rentExemptMin: bigint;
  operationsReserve: bigint; unpaidSolObligations: bigint; unspentBuyback: bigint;
  proposedSpend: bigint; proposedFrom: "SOL_REWARDS" | "BUYBACK"; proposedCosts: bigint; opsCostBudgetRemaining: bigint;
  emergencyStop: boolean;
}) {
  const r: string[] = [];
  if (x.emergencyStop) r.push("EMERGENCY_STOP");
  if (x.finalizedBalance === null) r.push("BALANCE_UNKNOWN");
  const bucket = x.proposedFrom === "SOL_REWARDS" ? x.unpaidSolObligations : x.unspentBuyback;
  if (x.proposedSpend > bucket) r.push("SPEND_EXCEEDS_BUCKET");
  if (x.proposedCosts > x.opsCostBudgetRemaining) r.push("COST_BUDGET_EXCEEDED");
  const required = x.rentExemptMin + x.operationsReserve + x.unpaidSolObligations + x.unspentBuyback + x.proposedCosts;
  if (x.finalizedBalance !== null && x.finalizedBalance < required) r.push("INSUFFICIENT_BALANCE_FOR_RESERVES");
  return r.length ? { ok: false as const, reasons: r } : { ok: true as const };
}

/** Future Render-only signer secret. Validated for SHAPE only; the value is never returned, logged or stored. */
export const SIGNER_SECRET_ENV = "MCPX_NATIVE_DEPLOYER_PRIVATE_KEY";
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function signerSecretShape(raw: string | null | undefined): "ABSENT" | "BASE58_64" | "JSON_64" | "INVALID" {
  if (!raw) return "ABSENT";
  const t = raw.trim();
  if (t.startsWith("[")) {
    try { const a = JSON.parse(t); return Array.isArray(a) && a.length === 64 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? "JSON_64" : "INVALID"; }
    catch { return "INVALID"; }
  }
  return B58.test(t) && t.length >= 86 && t.length <= 88 ? "BASE58_64" : "INVALID";
}

/** Worker startup gate for this phase: any signer secret present → refuse (execution is not implemented). */
export function signerStartupGate(raw: string | null | undefined) {
  const shape = signerSecretShape(raw);
  return shape === "ABSENT" ? { start: true as const } : { start: false as const, reason: `SIGNER_SECRET_PRESENT_EXECUTION_NOT_IMPLEMENTED:${shape}` };
}
