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
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
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
  let bytes: number;
  try { bytes = tx.serialize().length; } catch { return { kind: "BLOCKED", reason: "TX_TOO_LARGE:overrun" }; }
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
export async function curveBuyInstructions(conn: Connection, mint: PublicKey, buyer: PublicKey, b: BuyBounds, tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID) {
  if (b.budgetLamports <= 0n) return { kind: "BLOCKED" as const, reason: "ZERO_BUDGET" };
  if (b.maxSlippageBps < 1 || b.maxSlippageBps > 500) return { kind: "BLOCKED" as const, reason: "SLIPPAGE_OUT_OF_RANGE" };
  const sdk = new OnlinePumpSdk(conn);
  const global = await sdk.fetchGlobal();
  const feeConfig = await sdk.fetchFeeConfig().catch(() => null);
  const st = await sdk.fetchBuyState(mint, buyer, tokenProgram);
  if (st.bondingCurve.complete) return { kind: "BLOCKED" as const, reason: "CURVE_COMPLETE_AMM_BUY_ROUTE_NOT_IMPLEMENTED" };
  const sol = new BN(b.budgetLamports.toString());
  const out = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: sol, quoteMint: st.quoteMint ?? NATIVE_MINT });
  const expected = BigInt(out.toString());
  if (expected < b.minOutTokens) return { kind: "BLOCKED" as const, reason: "QUOTE_BELOW_MIN_OUT" };
  const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve,
    associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: buyer, amount: out, solAmount: sol, slippage: b.maxSlippageBps / 100, tokenProgram });
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

/** Token program is DERIVED from the mint account owner (native $MCP = Token-2022 via create_v2); legacy SPL stays supported. */
export async function mintTokenProgram(conn: Connection, mint: PublicKey) {
  const a = await conn.getAccountInfo(mint, "finalized");
  const o = a?.owner.toBase58();
  return o === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : o === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : null;
}

export function tokenPayoutIxs(from: PublicKey, mint: PublicKey, decimals: number, rows: readonly { owner: string; amount: bigint; ataExists: boolean }[], tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID) {
  const src = getAssociatedTokenAddressSync(mint, from, false, tokenProgram);
  const seen = new Set<string>(); const ixs: TransactionInstruction[] = []; let atasCreated = 0;
  for (const r of rows) {
    if (seen.has(r.owner)) throw new Error("duplicate_owner"); seen.add(r.owner);
    if (r.amount <= 0n) throw new Error("non_positive_amount");
    const owner = new PublicKey(r.owner);
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error("off_curve_owner_requires_review"); // PDAs held, never paid blindly
    const dst = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    if (!r.ataExists) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, dst, owner, mint, tokenProgram)); atasCreated++; }
    ixs.push(createTransferCheckedInstruction(src, mint, dst, from, r.amount, decimals, [], tokenProgram));
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

// ---------- EXEC-01B: PumpSwap (post-graduation) creator-fee collection + canonical-pool buyback ----------
/** WSOL creator vault → deployer. The SDK unwraps by closing the deployer's WSOL ATA, so any pre-existing WSOL balance
 *  (unaccounted funds) blocks: we never sweep unknown balances into "income". */
export async function ammCollectInstructions(conn: Connection, deployer: PublicKey) {
  const sdk = new OnlinePumpAmmSdk(conn);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, deployer, false, TOKEN_PROGRAM_ID);
  const pre = await conn.getTokenAccountBalance(ata, "finalized").then((b) => BigInt(b.value.amount)).catch(() => 0n);
  if (pre !== 0n) return { kind: "BLOCKED" as const, reason: "WSOL_UNACCOUNTED_BALANCE" };
  const st = await sdk.collectCoinCreatorFeeSolanaState(deployer);
  const ixs = await PUMP_AMM_SDK.collectCoinCreatorFee(st, deployer);
  return { kind: "OK" as const, ixs };
}

/** Bounded SOL→mint buy on the CANONICAL PumpSwap pool only (no other venue). Fill is verified later from finalized balances. */
export async function ammBuyInstructions(conn: Connection, mint: PublicKey, buyer: PublicKey, b: BuyBounds) {
  if (b.budgetLamports <= 0n) return { kind: "BLOCKED" as const, reason: "ZERO_BUDGET" };
  if (b.maxSlippageBps < 1 || b.maxSlippageBps > 500) return { kind: "BLOCKED" as const, reason: "SLIPPAGE_OUT_OF_RANGE" };
  const pool = canonicalPumpPoolPda(mint);
  const sdk = new OnlinePumpAmmSdk(conn);
  const st = await sdk.swapSolanaState(pool, buyer).catch(() => null);
  if (!st || !st.poolAccountInfo) return { kind: "BLOCKED" as const, reason: "CANONICAL_POOL_MISSING" };
  if (!st.pool.baseMint.equals(mint) || !st.pool.quoteMint.equals(NATIVE_MINT)) return { kind: "BLOCKED" as const, reason: "POOL_MINT_MISMATCH" };
  if (st.poolAccountInfo.owner.toBase58() !== PUMP_AMM_PROGRAM_ID.toBase58()) return { kind: "BLOCKED" as const, reason: "POOL_PROGRAM_MISMATCH" };
  const base = BigInt(st.poolBaseAmount.toString()), quote = BigInt(st.poolQuoteAmount.toString());
  if (base === 0n || quote === 0n) return { kind: "BLOCKED" as const, reason: "INSUFFICIENT_LIQUIDITY" };
  if (b.budgetLamports * 20n > quote) return { kind: "BLOCKED" as const, reason: "PRICE_IMPACT_TOO_HIGH" }; // >5% of quote reserve
  // constant-product estimate before fees, then slippage bound; real fill comes from finalized balances only
  const est = (base * b.budgetLamports) / (quote + b.budgetLamports);
  const minOut = (est * BigInt(10_000 - b.maxSlippageBps)) / 10_000n;
  if (minOut < b.minOutTokens || minOut <= 0n) return { kind: "BLOCKED" as const, reason: "QUOTE_BELOW_MIN_OUT" };
  const ixs = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(st, new BN(b.budgetLamports.toString()), new BN(minOut.toString()));
  return { kind: "OK" as const, ixs, pool: pool.toBase58(), expectedTokens: est, minOutTokens: minOut, baseTokenProgram: st.baseTokenProgram.toBase58() };
}
