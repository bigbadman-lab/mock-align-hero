// Phase 05-G — UNSIGNED transaction assembly for the single-deployer native rewards model.
// Builds real Solana instructions/messages with the pinned SDKs. There is NO signing, key reading or sending here:
// every output is an unsigned v0 message plus measurements. Used only by the dry-run worker and local probes.
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, creatorVaultPda, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-sdk";
import BN from "bn.js";

export const MAX_TX_BYTES = 1232;
export const MAX_CU = 1_400_000;

/** Programs any native-rewards transaction may touch. Anything else → refused. */
export const PROGRAM_ALLOWLIST = new Set([
  SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58(),
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // Pump fee program (referenced by buy/collect)
]);

export type Unsigned = {
  kind: "UNSIGNED"; messageBase64: string; bytes: number; signers: string[]; programs: string[];
  recentBlockhash: string; lastValidBlockHeight: number; computeUnitLimit: number;
};
export type Refusal = { kind: "BLOCKED"; reason: string };

/** Compile an unsigned v0 transaction. Size, signer and program checks fail closed. */
export function assemble(ixs: TransactionInstruction[], payer: PublicKey, bh: { blockhash: string; lastValidBlockHeight: number },
  opts: { cuLimit: number; cuPriceMicroLamports: number; allowedSigners: readonly string[] }): Unsigned | Refusal {
  if (!(opts.cuLimit > 0 && opts.cuLimit <= MAX_CU)) return { kind: "BLOCKED", reason: "CU_LIMIT_OUT_OF_RANGE" };
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.cuPriceMicroLamports }), ...ixs];
  const programs = [...new Set(all.map((i) => i.programId.toBase58()))];
  const bad = programs.find((p) => !PROGRAM_ALLOWLIST.has(p));
  if (bad) return { kind: "BLOCKED", reason: `PROGRAM_NOT_ALLOWED:${bad}` };
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions: all }).compileToV0Message();
  const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const extra = signers.find((s) => !opts.allowedSigners.includes(s));
  if (extra) return { kind: "BLOCKED", reason: `UNEXPECTED_SIGNER:${extra}` };
  const tx = new VersionedTransaction(msg); // signatures are zero-filled placeholders; nothing is signed
  const bytes = tx.serialize().length;
  if (bytes > MAX_TX_BYTES) return { kind: "BLOCKED", reason: `TX_TOO_LARGE:${bytes}` };
  return { kind: "UNSIGNED", messageBase64: Buffer.from(msg.serialize()).toString("base64"), bytes, signers, programs,
    recentBlockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, computeUnitLimit: opts.cuLimit };
}

/** Blockhash freshness: a plan whose lastValidBlockHeight has passed must be rebuilt, never re-sent. */
export function blockhashExpired(u: Pick<Unsigned, "lastValidBlockHeight">, currentBlockHeight: number | null) {
  if (currentBlockHeight === null) return "UNKNOWN" as const;
  return currentBlockHeight > u.lastValidBlockHeight;
}

// ---------- G01: fee collection (curve SOL vault + PumpSwap WSOL vault, SDK unwraps the AMM leg itself) ----------
export async function collectionInstructions(conn: Connection, deployer: PublicKey) {
  const sdk = new OnlinePumpSdk(conn);
  const ixs = await sdk.collectCoinCreatorFeeInstructions(deployer, deployer);
  const curveVault = creatorVaultPda(deployer);
  return { ixs, curveVault: curveVault.toBase58() };
}

/**
 * Explicit WSOL unwrap for WSOL that landed in the deployer's WSOL ATA. Close only if the ATA holds exactly the
 * ledger-accounted amount; any other balance (operator deposits, unrelated swaps) blocks — we never sweep unknown funds.
 */
export function wsolUnwrapPlan(deployer: PublicKey, ata: { exists: boolean; amount: bigint | null; owner: string | null; delegate: string | null; closeAuthority: string | null }, accountedWsol: bigint) {
  const address = getAssociatedTokenAddressSync(NATIVE_MINT, deployer, false, TOKEN_PROGRAM_ID);
  if (!ata.exists) return accountedWsol === 0n ? { kind: "NOTHING" as const } : { kind: "BLOCKED" as const, reason: "WSOL_ATA_MISSING_BUT_ACCOUNTED" };
  if (ata.amount === null) return { kind: "BLOCKED" as const, reason: "WSOL_BALANCE_UNKNOWN" };
  if (ata.owner !== deployer.toBase58()) return { kind: "BLOCKED" as const, reason: "WSOL_ATA_OWNER_MISMATCH" };
  if (ata.delegate) return { kind: "BLOCKED" as const, reason: "WSOL_ATA_DELEGATED" };
  if (ata.closeAuthority && ata.closeAuthority !== deployer.toBase58()) return { kind: "BLOCKED" as const, reason: "WSOL_CLOSE_AUTHORITY_FOREIGN" };
  if (ata.amount !== accountedWsol) return { kind: "BLOCKED" as const, reason: "WSOL_UNACCOUNTED_BALANCE" };
  return { kind: "CLOSE" as const, ix: createCloseAccountInstruction(address, deployer, deployer, [], TOKEN_PROGRAM_ID), unwrapLamports: ata.amount };
}

// ---------- G03: buyback on the bonding curve (only route the pinned SDK supports end-to-end here) ----------
export type BuyBounds = { budgetLamports: bigint; maxSlippageBps: number; minOutTokens: bigint };
export async function curveBuyInstructions(conn: Connection, mint: PublicKey, buyer: PublicKey, b: BuyBounds) {
  if (b.budgetLamports <= 0n) return { kind: "BLOCKED" as const, reason: "ZERO_BUDGET" };
  if (b.maxSlippageBps < 1 || b.maxSlippageBps > 500) return { kind: "BLOCKED" as const, reason: "SLIPPAGE_OUT_OF_RANGE" };
  const sdk = new OnlinePumpSdk(conn);
  const global = await sdk.fetchGlobal();
  const feeConfig = await sdk.fetchFeeConfig().catch(() => null);
  const st = await sdk.fetchBuyState(mint, buyer, TOKEN_2022_PROGRAM_ID);
  if (st.bondingCurve.complete) return { kind: "BLOCKED" as const, reason: "CURVE_COMPLETE_AMM_BUY_ROUTE_NOT_IMPLEMENTED" };
  const sol = new BN(b.budgetLamports.toString());
  const out = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: sol });
  const expected = BigInt(out.toString());
  if (expected < b.minOutTokens) return { kind: "BLOCKED" as const, reason: "QUOTE_BELOW_MIN_OUT" };
  const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve,
    associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: buyer, amount: out, solAmount: sol, slippage: b.maxSlippageBps / 100, tokenProgram: TOKEN_2022_PROGRAM_ID });
  return { kind: "OK" as const, ixs, expectedTokens: expected, maxSolCost: b.budgetLamports + (b.budgetLamports * BigInt(b.maxSlippageBps)) / 10_000n };
}

// ---------- G03: payouts ----------
export function solPayoutIxs(from: PublicKey, rows: readonly { owner: string; lamports: bigint }[]) {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (seen.has(r.owner)) throw new Error("duplicate_owner"); seen.add(r.owner);
    if (r.lamports <= 0n) throw new Error("non_positive_amount");
    return SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(r.owner), lamports: r.lamports });
  });
}

export function tokenPayoutIxs(from: PublicKey, mint: PublicKey, decimals: number, rows: readonly { owner: string; amount: bigint; ataExists: boolean }[]) {
  const src = getAssociatedTokenAddressSync(mint, from, false, TOKEN_2022_PROGRAM_ID);
  const seen = new Set<string>(); const ixs: TransactionInstruction[] = []; let atasCreated = 0;
  for (const r of rows) {
    if (seen.has(r.owner)) throw new Error("duplicate_owner"); seen.add(r.owner);
    if (r.amount <= 0n) throw new Error("non_positive_amount");
    const owner = new PublicKey(r.owner);
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error("off_curve_owner_requires_review"); // PDAs held, never paid blindly
    const dst = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    if (!r.ataExists) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, dst, owner, mint, TOKEN_2022_PROGRAM_ID)); atasCreated++; }
    ixs.push(createTransferCheckedInstruction(src, mint, dst, from, r.amount, decimals, [], TOKEN_2022_PROGRAM_ID));
  }
  return { ixs, atasCreated };
}

/** Greedy batching by real serialized size: largest prefix that fits, deterministic order by owner. */
export function batchBySize<T extends { owner: string }>(rows: readonly T[], build: (part: T[]) => Unsigned | Refusal, maxPerBatch = 20) {
  const sorted = [...rows].sort((a, b) => (a.owner < b.owner ? -1 : 1));
  const out: Unsigned[] = []; let i = 0;
  while (i < sorted.length) {
    let n = Math.min(maxPerBatch, sorted.length - i), got: Unsigned | null = null;
    for (; n >= 1; n--) { const r = build(sorted.slice(i, i + n)); if (r.kind === "UNSIGNED") { got = r; break; } }
    if (!got) return { kind: "BLOCKED" as const, reason: "SINGLE_RECIPIENT_TOO_LARGE", at: i };
    out.push(got); i += n;
  }
  return { kind: "OK" as const, batches: out };
}
