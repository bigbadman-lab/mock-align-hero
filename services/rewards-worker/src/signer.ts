// MCPX rewards worker — single deployer signer (pre-launch). WORKER-ONLY: never import from site/browser code.
// The private key is read once from the Render env, decoded, checked against the configured public address and
// kept only inside a closure. It is never returned, logged, hashed for display or sent anywhere.
// This module SIGNS validated plans; it has NO broadcast code. Sending needs its own approved phase.
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, VersionedMessage, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { createHash } from "node:crypto";
import { checkVenueTx, type VenueOk } from "./venue-check";
import type { ChildRecord, Shareholder } from "./child-fees";

export const PRIVATE_KEY_ENV = "MCPX_DEPLOYER_PRIVATE_KEY";
export const PUBLIC_KEY_ENV = "MCPX_DEPLOYER_PUBLIC_KEY";
/** Old name from 05-F. If present we do not read it — it blocks signing so there is never ambiguity about which key is live. */
export const LEGACY_PRIVATE_KEY_ENV = "MCPX_NATIVE_DEPLOYER_PRIVATE_KEY";
export const MAX_TX_BYTES = 1232;

export type SignerState = "MONITOR_ONLY" | "SIGNER_VALIDATED" | "SIGNER_INVALID";
export type PlanKind = "SOL_PAYOUT" | "TOKEN_PAYOUT" | "FEE_COLLECTION" | "BUYBACK" | "WSOL_UNWRAP";
/** Only these paths may be signed. The others stay blocked until built, simulated and verified on chain. */
export const SIGNABLE_KINDS: ReadonlySet<PlanKind> = new Set(["SOL_PAYOUT", "TOKEN_PAYOUT", "FEE_COLLECTION", "BUYBACK"]);

/** Technical limits (always on) + OPTIONAL operator emergency ceilings (null = not configured). Payout size itself is
 *  bounded by the verified fee-backed budget the intent store enforces, never by a fixed cap. */
export type Limits = {
  maxLamportsPerTx: bigint | null; maxLamportsPerCycle: bigint | null; maxTokensPerTx: bigint | null;
  maxComputeUnits: number; maxCuPriceMicroLamports: number; maxPriorityFeeLamports: bigint;
  blockhashMarginBlocks: number;
};
export const TECHNICAL_LIMITS = { maxComputeUnits: 400_000, maxCuPriceMicroLamports: 200_000, maxPriorityFeeLamports: 100_000n, blockhashMarginBlocks: 20 } as const;
export const BASE_FEE_PER_SIGNATURE = 5000n;
export type Plan = {
  kind: PlanKind; idempotencyKey: string; cycleId: string;
  /** Five-minute window (unix seconds) whose verified fee budget funds this batch. */
  epoch: number; messageBase64: string; lastValidBlockHeight: number;
  /** Exact expected recipients: SOL owners+lamports, or token owners+amount. Anything else in the tx → refused. */
  rows: readonly { owner: string; amount: bigint }[];
  mint?: string; decimals?: number;
  /** BUYBACK only: SOL reserved from the verified buyback budget; the message's max spend must fit inside it. */
  budgetLamports?: bigint;
};
export type IntentStore = {
  /** Durable reservation BEFORE signing. Must atomically refuse a key it has seen before. */
  /** Atomically: refuse a seen key, then check the epoch's verified fee-backed budget (SOL / buyback / token) and the
   *  operations reserve (network fees + rent), and reserve. Budget comes only from persisted finalized records. */
  reserve(i: { idempotencyKey: string; cycleId: string; kind: PlanKind; epoch: number; messageSha256: string; lamports: bigint; tokens: bigint; opsCostLamports: bigint; lastValidBlockHeight: number;
    /** 0020: exact immutable plan persisted with the reservation (required for payouts by the DB guard). */
    plan?: { rows: readonly { owner: string; amount: bigint }[]; mint: string | null; tokenProgram: string | null; messageBase64: string } }): Promise<ReserveResult>;
  /** Committed + reserved spend in this cycle (lamports), excluding the plan being checked. */
  cycleSpent(cycleId: string): Promise<bigint>;
  /** SIGNED + exact signed bytes in ONE write, before any network call (migration 0019). */
  recordSigned(idempotencyKey: string, signature: string, signedBase64: string): Promise<void>;
};
export type ReserveResult = "NEW" | "DUPLICATE" | "NO_SOL_BUDGET" | "NO_BUYBACK_BUDGET" | "NO_TOKEN_BUDGET" | "NO_OPS_RESERVE" | "NO_EVIDENCE";
export type SignCtx = { limits: Limits | null; emergencyStop: boolean; currentBlockHeight: number | null; store: IntentStore | null;
  /** Rent for one new associated token account (from getMinimumBalanceForRentExemption); required if the tx creates ATAs. */
  ataRentLamports?: bigint | null };
export type SignResult = { ok: true; signature: string; signedBase64: string } | { ok: false; reason: string };

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Accepted format: ONE base58 string encoding the 64-byte Solana secret key (Phantom / Pump.fun "export private key"). */
export function loadSigner(env: Record<string, string | undefined>) {
  const raw = env[PRIVATE_KEY_ENV]?.trim() || "";
  const pubRaw = env[PUBLIC_KEY_ENV]?.trim() || "";
  const legacy = !!env[LEGACY_PRIVATE_KEY_ENV]?.trim();
  const out = (state: SignerState, reason: string | null, address: string | null, kp: Keypair | null) => ({
    state, reason, address,
    sign: kp ? (plan: Plan, ctx: SignCtx) => signPlan(kp, plan, ctx) : null,
    /** Child-fee keeper: signs ONLY the permissionless Pump sweep/distribute built here and re-checked by checkChildTx. */
    signChild: kp ? (c: ChildRecord, sh: Shareholder[], graduated: boolean, blockhash: string, lastValidBlockHeight: number) => signChildTx(kp, c, sh, graduated, blockhash, lastValidBlockHeight) : null,
    /** Safe for logs: never contains key material. */
    describe: () => ({ signerState: state, signerReason: reason, deployerAddress: address }),
  });
  if (legacy) return out("SIGNER_INVALID", "LEGACY_KEY_ENV_PRESENT", null, null);
  if (!raw) return out("MONITOR_ONLY", pubRaw ? "PRIVATE_KEY_UNSET" : "SIGNER_UNCONFIGURED", null, null);
  let expected: PublicKey;
  try { if (!pubRaw) throw 0; expected = new PublicKey(pubRaw); } catch { return out("SIGNER_INVALID", "PUBLIC_KEY_INVALID", null, null); }
  if (raw.startsWith("[") || !B58.test(raw)) return out("SIGNER_INVALID", "PRIVATE_KEY_FORMAT", null, null);
  let bytes: Uint8Array;
  try { bytes = bs58.decode(raw); } catch { return out("SIGNER_INVALID", "PRIVATE_KEY_FORMAT", null, null); }
  if (bytes.length !== 64) { bytes.fill(0); return out("SIGNER_INVALID", "PRIVATE_KEY_LENGTH", null, null); }
  let kp: Keypair;
  // copy: web3.js keeps a reference to the array, and bytes is zeroed below
  try { kp = Keypair.fromSecretKey(Uint8Array.from(bytes)); } catch { bytes.fill(0); return out("SIGNER_INVALID", "PRIVATE_KEY_INCONSISTENT", null, null); }
  bytes.fill(0);
  if (!kp.publicKey.equals(expected)) return out("SIGNER_INVALID", "ADDRESS_MISMATCH", null, null);
  return out("SIGNER_VALIDATED", null, kp.publicKey.toBase58(), kp);
}

const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const u32 = (d: Uint8Array, o: number) => Buffer.from(d).readUInt32LE(o);

async function signPlan(kp: Keypair, plan: Plan, ctx: SignCtx): Promise<SignResult> {
  const no = (reason: string): SignResult => ({ ok: false, reason });
  if (ctx.emergencyStop) return no("EMERGENCY_STOP");
  const L = ctx.limits; if (!L) return no("LIMITS_UNSET");
  if (!ctx.store) return no("INTENT_STORE_UNAVAILABLE");
  if (!SIGNABLE_KINDS.has(plan.kind)) return no(`PATH_NOT_PROVEN:${plan.kind}`);
  if (!plan.idempotencyKey || !plan.cycleId) return no("IDEMPOTENCY_KEY_MISSING");
  if (ctx.currentBlockHeight === null) return no("BLOCK_HEIGHT_UNKNOWN");
  if (ctx.currentBlockHeight + L.blockhashMarginBlocks >= plan.lastValidBlockHeight) return no("BLOCKHASH_EXPIRED");

  let msgBytes: Uint8Array, msg: VersionedMessage;
  try { msgBytes = Buffer.from(plan.messageBase64, "base64"); msg = VersionedMessage.deserialize(msgBytes); } catch { return no("MESSAGE_UNPARSEABLE"); }
  if (msgBytes.length + 1 + 64 > MAX_TX_BYTES) return no("TX_TOO_LARGE");
  const me = kp.publicKey.toBase58();
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (msg.header.numRequiredSignatures !== 1 || keys[0] !== me) return no("UNEXPECTED_SIGNER");
  if (msg.addressTableLookups.length) return no("LOOKUP_TABLES_NOT_ALLOWED");

  let venue: VenueOk | null = null;
  if (plan.kind === "FEE_COLLECTION" || plan.kind === "BUYBACK") {
    if (plan.rows.length) return no("PLAN_ROWS_INVALID");
    const v = checkVenueTx(plan.kind, keys, msg.compiledInstructions, me, { mint: plan.mint, budgetLamports: plan.budgetLamports, maxCuPrice: L.maxCuPriceMicroLamports });
    if (!v.ok) return no(v.reason);
    venue = v;
  }
  const sys = SystemProgram.programId.toBase58(), cb = ComputeBudgetProgram.programId.toBase58();
  const tok = TOKEN_PROGRAM_ID.toBase58(), tok22 = TOKEN_2022_PROGRAM_ID.toBase58(), ata = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
  const allowed = plan.kind === "SOL_PAYOUT" ? new Set([sys, cb]) : new Set([cb, tok, tok22, ata, sys]);

  const expect = new Map<string, bigint>();
  for (const r of plan.rows) { if (expect.has(r.owner) || r.amount <= 0n) return no("PLAN_ROWS_INVALID"); expect.set(r.owner, r.amount); }
  const seen = new Map<string, bigint>();
  let cuLimit: number | null = null, cuPrice = 0, lamports = 0n, tokens = 0n, ataCreates = 0n;
  let mintPk: PublicKey | null = null, srcAta: string | null = null, tokenProg: string | null = null;
  if (plan.kind === "TOKEN_PAYOUT") {
    if (!plan.mint || plan.decimals === undefined) return no("MINT_UNSET");
    try { mintPk = new PublicKey(plan.mint); } catch { return no("MINT_INVALID"); }
  }

  for (const ix of venue ? [] : msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const d = ix.data; const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    if (!prog || !allowed.has(prog)) return no(`PROGRAM_NOT_ALLOWED:${prog ?? "?"}`);
    if (prog === cb) {
      if (d[0] === 2 && d.length === 5) { if (cuLimit !== null) return no("DUPLICATE_CU_LIMIT"); cuLimit = u32(d, 1); }
      else if (d[0] === 3 && d.length === 9) { const p = u64(d, 1); if (p > BigInt(L.maxCuPriceMicroLamports)) return no("CU_PRICE_TOO_HIGH"); cuPrice = Number(p); }
      else return no("COMPUTE_BUDGET_IX_NOT_ALLOWED");
      continue;
    }
    if (prog === sys) {
      if (plan.kind !== "SOL_PAYOUT") return no("SYSTEM_IX_NOT_ALLOWED");
      if (d.length !== 12 || u32(d, 0) !== 2 || acc.length !== 2 || acc[0] !== me) return no("SYSTEM_IX_NOT_TRANSFER_FROM_DEPLOYER");
      const to = acc[1]!, amt = u64(d, 4);
      if (seen.has(to) || expect.get(to) !== amt) return no("RECIPIENT_OR_AMOUNT_MISMATCH");
      seen.set(to, amt); lamports += amt; continue;
    }
    if (prog === ata) {
      // CreateIdempotent (data [1]): payer, ata, owner, mint, system, tokenProgram
      if (d.length !== 1 || d[0] !== 1 || acc[0] !== me || !acc[2] || !expect.has(acc[2]) || acc[3] !== plan.mint) return no("ATA_IX_NOT_ALLOWED");
      ataCreates += 1n; continue;
    }
    // token / token-2022: only TransferChecked (12): source, mint, dest, authority
    if (d.length !== 10 || d[0] !== 12 || acc.length !== 4) return no("TOKEN_IX_NOT_TRANSFER_CHECKED");
    if (tokenProg && tokenProg !== prog) return no("MIXED_TOKEN_PROGRAMS");
    tokenProg = prog;
    const progPk = new PublicKey(prog);
    srcAta ??= getAssociatedTokenAddressSync(mintPk!, kp.publicKey, false, progPk).toBase58();
    if (acc[0] !== srcAta || acc[1] !== plan.mint || acc[3] !== me || d[9] !== plan.decimals) return no("TOKEN_TRANSFER_SHAPE");
    const owner = [...expect.keys()].find((o) => getAssociatedTokenAddressSync(mintPk!, new PublicKey(o), true, progPk).toBase58() === acc[2]);
    const amt = u64(d, 1);
    if (!owner || seen.has(owner) || expect.get(owner) !== amt) return no("RECIPIENT_OR_AMOUNT_MISMATCH");
    seen.set(owner, amt); tokens += amt;
  }
  if (seen.size !== expect.size) return no("PLAN_ROWS_NOT_ALL_PRESENT");
  if (venue) { cuLimit = venue.cuLimit; cuPrice = venue.cuPrice; lamports = venue.lamports; }
  if (cuLimit === null || cuLimit <= 0 || cuLimit > L.maxComputeUnits) return no("CU_LIMIT_OUT_OF_RANGE");
  const priority = (BigInt(cuLimit) * BigInt(cuPrice) + 999_999n) / 1_000_000n;
  if (priority > L.maxPriorityFeeLamports) return no("PRIORITY_FEE_TOO_HIGH");
  // Operator emergency ceilings: only when configured; hitting one HOLDS the batch (entitlements kept, resumable).
  if (L.maxLamportsPerTx !== null && lamports > L.maxLamportsPerTx) return no("OPERATOR_CEILING_REACHED:TX_LAMPORTS");
  if (L.maxTokensPerTx !== null && tokens > L.maxTokensPerTx) return no("OPERATOR_CEILING_REACHED:TX_TOKENS");
  if (L.maxLamportsPerCycle !== null) {
    let spent: bigint;
    try { spent = await ctx.store.cycleSpent(plan.cycleId); } catch { return no("INTENT_STORE_UNAVAILABLE"); }
    if (spent + lamports > L.maxLamportsPerCycle) return no("OPERATOR_CEILING_REACHED:CYCLE_LAMPORTS");
  }
  if (!Number.isInteger(plan.epoch) || plan.epoch <= 0 || plan.epoch % 300 !== 0) return no("EPOCH_INVALID");
  if (ataCreates > 0n && !(ctx.ataRentLamports && ctx.ataRentLamports > 0n)) return no("ATA_RENT_UNKNOWN");
  // Network fee + priority fee + rent are charged to the operations reserve, never to holder amounts.
  const opsCostLamports = BASE_FEE_PER_SIGNATURE + priority + ataCreates * (ctx.ataRentLamports ?? 0n);

  const messageSha256 = createHash("sha256").update(msgBytes).digest("hex");
  let r: ReserveResult;
  try { r = await ctx.store.reserve({ idempotencyKey: plan.idempotencyKey, cycleId: plan.cycleId, kind: plan.kind, epoch: plan.epoch, messageSha256, lamports, tokens, opsCostLamports, lastValidBlockHeight: plan.lastValidBlockHeight,
    plan: { rows: plan.rows, mint: plan.mint ?? null, tokenProgram: tokenProg ?? null, messageBase64: plan.messageBase64 } }); }
  catch { return no("INTENT_STORE_UNAVAILABLE"); }
  if (r === "DUPLICATE") return no("DUPLICATE_INTENT");
  if (r !== "NEW") return no(r);

  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const signature = bs58.encode(tx.signatures[0]!);
  const signedBase64 = Buffer.from(tx.serialize()).toString("base64");
  try { await ctx.store.recordSigned(plan.idempotencyKey, signature, signedBase64); } catch { return no("SIGNATURE_NOT_RECORDED"); } // unrecorded → never send
  return { ok: true, signature, signedBase64 };
}

/** After a crash/timeout: what may happen to a signed intent. Only EXPIRED_NOT_LANDED allows a NEW plan (new key). */
export function reconcile(i: { signature: string | null; lastValidBlockHeight: number },
  chain: { status: "FINALIZED_OK" | "FINALIZED_ERR" | "NOT_FOUND" | "UNKNOWN"; finalizedBlockHeight: number | null }) {
  if (i.signature === null) return "NEVER_SIGNED" as const;
  if (chain.status === "FINALIZED_OK") return "LANDED" as const;
  if (chain.status === "FINALIZED_ERR") return "FAILED_ON_CHAIN" as const;
  if (chain.status === "UNKNOWN" || chain.finalizedBlockHeight === null) return "WAIT" as const;
  return chain.finalizedBlockHeight > i.lastValidBlockHeight ? ("EXPIRED_NOT_LANDED" as const) : ("WAIT" as const);
}

/** Optional operator emergency ceilings (raw units: lamports / token base units). Absent → null (budget still applies).
 *  Present but invalid → { ok:false } so the worker blocks signing rather than silently ignoring it. */
export function readLimits(env: Record<string, string | undefined>): { ok: true; limits: Limits } | { ok: false; invalid: string[] } {
  const bad: string[] = [];
  const opt = (k: string) => { const v = env[k]?.trim(); if (!v) return null; if (/^\d+$/.test(v) && BigInt(v) > 0n) return BigInt(v); bad.push(k); return null; };
  const tx = opt("MCPX_REWARDS_MAX_LAMPORTS_PER_TX"), cyc = opt("MCPX_REWARDS_MAX_LAMPORTS_PER_CYCLE"), tok = opt("MCPX_REWARDS_MAX_TOKENS_PER_TX");
  if (tx !== null && cyc !== null && tx > cyc) bad.push("MCPX_REWARDS_MAX_LAMPORTS_PER_TX>CYCLE");
  if (bad.length) return { ok: false, invalid: bad };
  return { ok: true, limits: { maxLamportsPerTx: tx, maxLamportsPerCycle: cyc, maxTokensPerTx: tok, ...TECHNICAL_LIMITS } };
}

export type ReadinessInput = {
  signer: SignerState; mintVerified: boolean; eligibilityApproved: boolean; snapshotComplete: boolean; feeOwnershipConfirmed: boolean;
  intentStoreReady: boolean; simulationsPassed: boolean; reservesSufficient: boolean; operatorAuthorized: boolean;
  limitsSet: boolean; emergencyStop: boolean;
};
/** Real gate, no decorative flag: EXECUTION_READY only when every check is true. */
export function executionReadiness(x: ReadinessInput) {
  if (x.signer === "MONITOR_ONLY") return { state: "MONITOR_ONLY" as const, blockers: ["SIGNER_NOT_CONFIGURED"] };
  if (x.signer === "SIGNER_INVALID") return { state: "EXECUTION_BLOCKED" as const, blockers: ["SIGNER_INVALID"] };
  const b: string[] = [];
  if (x.emergencyStop) b.push("EMERGENCY_STOP");
  if (!x.limitsSet) b.push("OPERATOR_CEILING_INVALID");
  if (!x.mintVerified) b.push("MINT_NOT_VERIFIED");
  if (!x.eligibilityApproved) b.push("ELIGIBILITY_NOT_APPROVED");
  if (!x.snapshotComplete) b.push("SNAPSHOT_INCOMPLETE");
  if (!x.feeOwnershipConfirmed) b.push("FEE_OWNERSHIP_UNCONFIRMED");
  if (!x.intentStoreReady) b.push("INTENT_STORE_NOT_READY");
  if (!x.simulationsPassed) b.push("SIMULATIONS_NOT_PASSED");
  if (!x.reservesSufficient) b.push("RESERVES_UNVERIFIED");
  if (!x.operatorAuthorized) b.push("OPERATOR_NOT_AUTHORIZED");
  if (x.emergencyStop) return { state: "EXECUTION_BLOCKED" as const, blockers: b };
  return b.length ? { state: "SIGNER_VALIDATED" as const, blockers: b } : { state: "EXECUTION_READY" as const, blockers: [] };
}

export type ChildSigned = { signature: string; signedBase64: string; lastValidBlockHeight: number };
async function signChildTx(kp: Keypair, c: ChildRecord, sh: Shareholder[], graduated: boolean, blockhash: string, lastValidBlockHeight: number): Promise<ChildSigned> {
  const { buildChildDistribution, checkChildTx } = await import("./child-fees-build"); // lazy: keeps Pump SDK out of plain signer imports
  const me = kp.publicKey.toBase58();
  const ixs = await buildChildDistribution(c, me, sh, graduated);
  const chk = checkChildTx(ixs, me, c, graduated);
  if (!chk.ok) throw new Error(`CHILD_TX_REFUSED:${chk.code}`);
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  if (msg.header.numRequiredSignatures !== 1 || msg.staticAccountKeys[0]!.toBase58() !== me) throw new Error("CHILD_TX_REFUSED:UNEXPECTED_SIGNER");
  const tx = new VersionedTransaction(msg); tx.sign([kp]);
  const raw = tx.serialize(); if (raw.length > MAX_TX_BYTES) throw new Error("CHILD_TX_REFUSED:TX_TOO_LARGE");
  return { signature: bs58.encode(tx.signatures[0]!), signedBase64: Buffer.from(raw).toString("base64"), lastValidBlockHeight };
}
