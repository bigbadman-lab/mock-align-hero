// MCPX rewards worker — single deployer signer (pre-launch). WORKER-ONLY: never import from site/browser code.
// The private key is read once from the Render env, decoded, checked against the configured public address and
// kept only inside a closure. It is never returned, logged, hashed for display or sent anywhere.
// This module SIGNS validated plans; it has NO broadcast code. Sending needs its own approved phase.
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { createHash } from "node:crypto";

export const PRIVATE_KEY_ENV = "MCPX_DEPLOYER_PRIVATE_KEY";
export const PUBLIC_KEY_ENV = "MCPX_DEPLOYER_PUBLIC_KEY";
/** Old name from 05-F. If present we do not read it — it blocks signing so there is never ambiguity about which key is live. */
export const LEGACY_PRIVATE_KEY_ENV = "MCPX_NATIVE_DEPLOYER_PRIVATE_KEY";
export const MAX_TX_BYTES = 1232;

export type SignerState = "MONITOR_ONLY" | "SIGNER_VALIDATED" | "SIGNER_INVALID";
export type PlanKind = "SOL_PAYOUT" | "TOKEN_PAYOUT" | "FEE_COLLECTION" | "BUYBACK" | "WSOL_UNWRAP";
/** Only these paths may be signed. The others stay blocked until built, simulated and verified on chain. */
export const SIGNABLE_KINDS: ReadonlySet<PlanKind> = new Set(["SOL_PAYOUT", "TOKEN_PAYOUT"]);

export type Limits = {
  maxLamportsPerTx: bigint; maxLamportsPerCycle: bigint; maxTokensPerTx: bigint;
  maxComputeUnits: number; maxCuPriceMicroLamports: number; maxPriorityFeeLamports: bigint;
  blockhashMarginBlocks: number;
};
export type Plan = {
  kind: PlanKind; idempotencyKey: string; cycleId: string; messageBase64: string; lastValidBlockHeight: number;
  /** Exact expected recipients: SOL owners+lamports, or token owners+amount. Anything else in the tx → refused. */
  rows: readonly { owner: string; amount: bigint }[];
  mint?: string; decimals?: number;
};
export type IntentStore = {
  /** Durable reservation BEFORE signing. Must atomically refuse a key it has seen before. */
  reserve(i: { idempotencyKey: string; cycleId: string; kind: PlanKind; messageSha256: string; lamports: bigint; lastValidBlockHeight: number }): Promise<"NEW" | "DUPLICATE">;
  /** Committed + reserved spend in this cycle (lamports), excluding the plan being checked. */
  cycleSpent(cycleId: string): Promise<bigint>;
  recordSigned(idempotencyKey: string, signature: string): Promise<void>;
};
export type SignCtx = { limits: Limits | null; emergencyStop: boolean; currentBlockHeight: number | null; store: IntentStore | null };
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
    /** Safe for logs: never contains key material. */
    describe: () => ({ signerState: state, signerReason: reason, deployerAddress: address }),
  });
  if (legacy) return out("SIGNER_INVALID", "LEGACY_KEY_ENV_PRESENT", null, null);
  if (!raw) return out("MONITOR_ONLY", pubRaw ? "PRIVATE_KEY_UNSET" : "SIGNER_UNCONFIGURED", null, null);
  let expected: PublicKey;
  try { expected = new PublicKey(pubRaw); if (!pubRaw) throw 0; } catch { return out("SIGNER_INVALID", "PUBLIC_KEY_INVALID", null, null); }
  if (raw.startsWith("[") || !B58.test(raw)) return out("SIGNER_INVALID", "PRIVATE_KEY_FORMAT", null, null);
  let bytes: Uint8Array;
  try { bytes = bs58.decode(raw); } catch { return out("SIGNER_INVALID", "PRIVATE_KEY_FORMAT", null, null); }
  if (bytes.length !== 64) { bytes.fill(0); return out("SIGNER_INVALID", "PRIVATE_KEY_LENGTH", null, null); }
  let kp: Keypair;
  try { kp = Keypair.fromSecretKey(bytes); } catch { bytes.fill(0); return out("SIGNER_INVALID", "PRIVATE_KEY_INCONSISTENT", null, null); }
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

  const sys = SystemProgram.programId.toBase58(), cb = ComputeBudgetProgram.programId.toBase58();
  const tok = TOKEN_PROGRAM_ID.toBase58(), tok22 = TOKEN_2022_PROGRAM_ID.toBase58(), ata = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
  const allowed = plan.kind === "SOL_PAYOUT" ? new Set([sys, cb]) : new Set([cb, tok, tok22, ata, sys]);

  const expect = new Map<string, bigint>();
  for (const r of plan.rows) { if (expect.has(r.owner) || r.amount <= 0n) return no("PLAN_ROWS_INVALID"); expect.set(r.owner, r.amount); }
  const seen = new Map<string, bigint>();
  let cuLimit: number | null = null, cuPrice = 0, lamports = 0n, tokens = 0n;
  let mintPk: PublicKey | null = null, srcAta: string | null = null, tokenProg: string | null = null;
  if (plan.kind === "TOKEN_PAYOUT") {
    if (!plan.mint || plan.decimals === undefined) return no("MINT_UNSET");
    try { mintPk = new PublicKey(plan.mint); } catch { return no("MINT_INVALID"); }
  }

  for (const ix of msg.compiledInstructions) {
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
      continue;
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
  if (cuLimit === null || cuLimit <= 0 || cuLimit > L.maxComputeUnits) return no("CU_LIMIT_OUT_OF_RANGE");
  const priority = (BigInt(cuLimit) * BigInt(cuPrice) + 999_999n) / 1_000_000n;
  if (priority > L.maxPriorityFeeLamports) return no("PRIORITY_FEE_TOO_HIGH");
  if (lamports > L.maxLamportsPerTx) return no("TX_SPEND_CAP");
  if (tokens > L.maxTokensPerTx) return no("TX_TOKEN_CAP");
  let spent: bigint;
  try { spent = await ctx.store.cycleSpent(plan.cycleId); } catch { return no("INTENT_STORE_UNAVAILABLE"); }
  if (spent + lamports > L.maxLamportsPerCycle) return no("CYCLE_SPEND_CAP");

  const messageSha256 = createHash("sha256").update(msgBytes).digest("hex");
  let r: "NEW" | "DUPLICATE";
  try { r = await ctx.store.reserve({ idempotencyKey: plan.idempotencyKey, cycleId: plan.cycleId, kind: plan.kind, messageSha256, lamports, lastValidBlockHeight: plan.lastValidBlockHeight }); }
  catch { return no("INTENT_STORE_UNAVAILABLE"); }
  if (r !== "NEW") return no("DUPLICATE_INTENT");

  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const signature = bs58.encode(tx.signatures[0]!);
  try { await ctx.store.recordSigned(plan.idempotencyKey, signature); } catch { return no("SIGNATURE_NOT_RECORDED"); } // unrecorded → never send
  return { ok: true, signature, signedBase64: Buffer.from(tx.serialize()).toString("base64") };
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

/** Strict caps from env. Any missing/invalid value → null → signing refused (fail closed). */
export function readLimits(env: Record<string, string | undefined>): Limits | null {
  const big = (k: string) => { const v = env[k]?.trim(); return v && /^\d+$/.test(v) && BigInt(v) > 0n ? BigInt(v) : null; };
  const L = {
    maxLamportsPerTx: big("MCPX_REWARDS_MAX_LAMPORTS_PER_TX"), maxLamportsPerCycle: big("MCPX_REWARDS_MAX_LAMPORTS_PER_CYCLE"),
    maxTokensPerTx: big("MCPX_REWARDS_MAX_TOKENS_PER_TX"),
  };
  if (!L.maxLamportsPerTx || !L.maxLamportsPerCycle || !L.maxTokensPerTx || L.maxLamportsPerTx > L.maxLamportsPerCycle) return null;
  return { maxLamportsPerTx: L.maxLamportsPerTx, maxLamportsPerCycle: L.maxLamportsPerCycle, maxTokensPerTx: L.maxTokensPerTx,
    maxComputeUnits: 400_000, maxCuPriceMicroLamports: 200_000, maxPriorityFeeLamports: 100_000n, blockhashMarginBlocks: 20 };
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
  if (!x.limitsSet) b.push("SPEND_LIMITS_UNSET");
  if (!x.mintVerified) b.push("MINT_NOT_VERIFIED");
  if (!x.eligibilityApproved) b.push("ELIGIBILITY_NOT_APPROVED");
  if (!x.snapshotComplete) b.push("SNAPSHOT_INCOMPLETE");
  if (!x.feeOwnershipConfirmed) b.push("FEE_OWNERSHIP_UNCONFIRMED");
  if (!x.intentStoreReady) b.push("INTENT_STORE_NOT_READY");
  if (!x.simulationsPassed) b.push("SIMULATIONS_NOT_PASSED");
  if (!x.reservesSufficient) b.push("RESERVES_UNVERIFIED");
  if (!x.operatorAuthorized) b.push("OPERATOR_NOT_AUTHORIZED");
  return b.length ? { state: "SIGNER_VALIDATED" as const, blockers: b } : { state: "EXECUTION_READY" as const, blockers: [] };
}
