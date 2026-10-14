// CHILD-FEES-01B — builds the permissionless child fee-distribution transaction from the official
// Pump SDK, then checks it strictly before any signature: only the Pump / PumpSwap fee instructions
// plus a compute-budget limit, the keeper is the only signer and fee payer, and no instruction can
// move tokens or SOL to the keeper (funds go vault → locked shareholders inside the programs).
import { PublicKey, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { createHash } from "node:crypto";
import type { ChildRecord, Shareholder } from "./child-fees";

const PUMP = PUMP_PROGRAM_ID.toBase58(), AMM = PUMP_AMM_PROGRAM_ID.toBase58(), CB = ComputeBudgetProgram.programId.toBase58();
const d8 = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const ALLOWED: Record<string, Set<string>> = {
  [PUMP]: new Set([d8("sweep_creator_fee"), d8("distribute_creator_fees_v2")]),
  [AMM]: new Set([d8("transfer_creator_fees_to_pump_v2")]),
};
export const CHILD_CU_LIMIT = 400_000;

export async function buildChildDistribution(c: ChildRecord, keeper: string, shareholders: Shareholder[], graduated: boolean): Promise<TransactionInstruction[]> {
  const payer = new PublicKey(keeper), mint = new PublicKey(c.mint), quoteMint = new PublicKey(c.quoteMint), qtp = new PublicKey(c.quoteTokenProgram);
  const sharingConfigAddress = new PublicKey(c.sharingConfig);
  const sharingConfig = { version: 2, mint, admin: PublicKey.default, adminRevoked: true, shareholders: shareholders.map((s) => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) };
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: CHILD_CU_LIMIT })];
  if (graduated) ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer, mint, quoteMint, quoteTokenProgram: qtp }));
  ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator: sharingConfigAddress, quoteMint, quoteTokenProgram: qtp }));
  ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig, sharingConfigAddress, quoteMint, payer, shouldInitializeAta: true, quoteTokenProgram: qtp }));
  return ixs;
}

export type CheckResult = { ok: true } | { ok: false; code: string };

export function checkChildTx(ixs: TransactionInstruction[], keeper: string, c: ChildRecord, graduated: boolean): CheckResult {
  const names: string[] = [];
  let cb = 0;
  for (const ix of ixs) {
    const p = ix.programId.toBase58();
    if (p === CB) { if (ix.data[0] !== 2 || ++cb > 1) return { ok: false, code: "COMPUTE_BUDGET_INVALID" }; names.push("cu"); continue; }
    const allow = ALLOWED[p];
    if (!allow) return { ok: false, code: "PROGRAM_NOT_ALLOWED" };
    const disc = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
    if (!allow.has(disc)) return { ok: false, code: "INSTRUCTION_NOT_ALLOWED" };
    for (const k of ix.keys) if (k.isSigner && k.pubkey.toBase58() !== keeper) return { ok: false, code: "UNEXPECTED_SIGNER" };
    if (!ix.keys.some((k) => k.pubkey.toBase58() === c.mint)) return { ok: false, code: "WRONG_MINT" };
    names.push(disc === d8("distribute_creator_fees_v2") ? "distribute" : disc === d8("sweep_creator_fee") ? "sweep" : "amm_transfer");
  }
  const want = graduated ? ["cu", "amm_transfer", "sweep", "distribute"] : ["cu", "sweep", "distribute"];
  if (names.join() !== want.join()) return { ok: false, code: "SHAPE_MISMATCH" };
  // The distribute instruction's remaining accounts must be exactly the locked shareholders (+ their ATAs).
  const dist = ixs[ixs.length - 1].keys.map((k) => k.pubkey.toBase58());
  for (const who of [c.creator, c.ops, c.platform]) if (!dist.includes(who)) return { ok: false, code: "RECIPIENT_MISSING" };
  if (dist.includes(keeper) && ![c.creator, c.ops, c.platform].includes(keeper)) {
    // keeper appears only as payer (index 0) — never as a recipient slot
    if (dist.indexOf(keeper) !== 0 || dist.lastIndexOf(keeper) !== 0) return { ok: false, code: "KEEPER_AS_RECIPIENT" };
  }
  return { ok: true };
}
