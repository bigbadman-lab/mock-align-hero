// Candidate assembly from official SDK instruction builders. Pure: all chain state is passed in.
// Order (fee-first): create_v2 → create_fee_sharing_config → creator-vault quote ATA → update_fee_shares_v2 → [optional buy].
import { pump, web3, spl, BN, PROGRAMS, instructionName } from "./sdk.mjs";
import { FEE_SPLIT_BPS } from "./config.mjs";
import { createRequire } from "node:module";
const bs58 = createRequire(import.meta.url)("bs58");

const { PublicKey, Transaction, TransactionMessage, VersionedTransaction } = web3;
export const PACKET_LIMIT = web3.PACKET_DATA_SIZE; // 1232 in the pinned web3.js
export const CANDIDATE_IDS = Object.freeze({ A: "create_v2", B: "fee_secured_create", C: "B+buy_v2", D: "B+buy_v3", E: "B+buy_exact_quote_in_v3", F: "D+shareholder_quote_atas" });

export class BuildError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }

export function shareholdersFor(creator, ops, platform) {
  const set = new Set([creator, ops, platform]);
  if (set.size !== 3) throw new BuildError("FEE_RECIPIENT_DUPLICATE");
  return [
    { address: new PublicKey(creator), shareBps: FEE_SPLIT_BPS.creator },
    { address: new PublicKey(ops), shareBps: FEE_SPLIT_BPS.ops },
    { address: new PublicKey(platform), shareBps: FEE_SPLIT_BPS.platform },
  ];
}

const web3bs58len = (b58) => bs58.decode(b58).length;
const shortvecLen = (n) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/** Compile without signing; size = signature vector + message (exact wire length once signed). */
export function compile(instructions, payer, blockhash, format, alts = []) {
  let msgBytes, header, keys;
  if (format === "legacy") {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
    tx.add(...instructions);
    const m = tx.compileMessage();
    header = m.header; keys = m.accountKeys;
    // web3.js serializes legacy messages into a fixed PACKET_DATA_SIZE buffer and throws past it,
    // so the exact length is computed from the compiled message instead.
    const ixLen = m.instructions.reduce((a, ci) => { const d = web3bs58len(ci.data); return a + 1 + shortvecLen(ci.accounts.length) + ci.accounts.length + shortvecLen(d) + d; }, 0);
    const len = 3 + shortvecLen(keys.length) + 32 * keys.length + 32 + shortvecLen(m.instructions.length) + ixLen;
    msgBytes = len <= PACKET_LIMIT ? m.serialize() : null;
    const n = header.numRequiredSignatures;
    return { messageBytes: msgBytes ? Buffer.from(msgBytes) : null, size: shortvecLen(n) + 64 * n + len, signers: keys.slice(0, n).map((k) => k.toBase58()), staticAccounts: keys.length };
  }
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(alts);
  header = m.header; keys = m.staticAccountKeys;
  // MessageV0.serialize also writes into a fixed PACKET_DATA_SIZE buffer; compute the exact length.
  const ixLen = m.compiledInstructions.reduce((a, ci) => a + 1 + shortvecLen(ci.accountKeyIndexes.length) + ci.accountKeyIndexes.length + shortvecLen(ci.data.length) + ci.data.length, 0);
  const lutLen = m.addressTableLookups.reduce((a, l) => a + 32 + shortvecLen(l.writableIndexes.length) + l.writableIndexes.length + shortvecLen(l.readonlyIndexes.length) + l.readonlyIndexes.length, 0);
  const len = 1 + 3 + shortvecLen(keys.length) + 32 * keys.length + 32 + shortvecLen(m.compiledInstructions.length) + ixLen + shortvecLen(m.addressTableLookups.length) + lutLen;
  msgBytes = len <= PACKET_LIMIT ? m.serialize() : null;
  const lookedUp = m.addressTableLookups.reduce((a, l) => a + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  const n = header.numRequiredSignatures;
  const size = shortvecLen(n) + 64 * n + len;
  return { messageBytes: msgBytes ? Buffer.from(msgBytes) : null, size, signers: keys.slice(0, n).map((k) => k.toBase58()), staticAccounts: keys.length, lookedUpAccounts: lookedUp };
}

export function manifest(ixs) {
  return ixs.map((ix, i) => ({
    index: i, program: ix.programId.toBase58(), name: instructionName(ix), dataBytes: ix.data.length,
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
  }));
}

/**
 * @param x {{ candidate:"A"|"B"|"C"|"D"|"E"|"F", creator:string, mint:string, name:string, symbol:string, uri:string,
 *   initialBuy: null|{mode:string, quoteAmount:string, slippageBps:number},
 *   quoteMint:string, quoteTokenProgram:PublicKey, opsRecipient:string, platformRecipient:string,
 *   global:any, feeConfig:any, parent:{curve:any, accounts:any} }}
 */
export async function assemble(x) {
  const sdk = pump.PUMP_SDK;
  const creator = new PublicKey(x.creator), mint = new PublicKey(x.mint), quoteMint = new PublicKey(x.quoteMint);
  const qtp = x.quoteTokenProgram;
  const shares = shareholdersFor(x.creator, x.opsRecipient, x.platformRecipient);
  const wrap = async (code, f) => { try { return await f(); } catch (e) { if (e instanceof BuildError) throw e; throw new BuildError(code, e?.constructor?.name ?? "error"); } };

  const createIx = await wrap("CREATE_V2_NOT_BUILDABLE", () => sdk.createV2Instruction({
    mint, name: x.name, symbol: x.symbol, uri: x.uri, creator, user: creator, mayhemMode: false,
    quoteMint, quoteTokenProgram: qtp, pumpQuote: x.parent.accounts,
  }));
  if (x.candidate === "A") return { instructions: [createIx], shares };

  const cfgIx = await wrap("FEE_SHARING_NOT_BUILDABLE", () => sdk.createFeeSharingConfig({ creator, mint, pool: null }));
  // Assumption (unverified on chain): a fresh sharing config's sole shareholder is the creator.
  const updIx = await wrap("FEE_SHARING_NOT_BUILDABLE", () => sdk.updateFeeSharesV2({
    authority: creator, mint, currentShareholders: [creator], newShareholders: shares,
    quoteMint, quoteTokenProgram: qtp, bondingCurveComplete: false,
  }));
  // Non-native quote ($MCP is Token-2022): update_fee_shares_v2 CPIs distribute_creator_fees_v2, which
  // requires the sharing-config creator vault's quote ATA to exist. A brand-new coin has none, so the
  // three-instruction form fails with InvalidAccountData (CHILD-FEES-01 local mainnet-clone execution).
  // Created idempotently, paid by the creator, inside the same atomic transaction.
  const vault = pump.creatorVaultPda(pump.feeSharingConfigPda(mint));
  const vaultAtaIx = spl.createAssociatedTokenAccountIdempotentInstruction(
    creator, spl.getAssociatedTokenAddressSync(quoteMint, vault, true, qtp), vault, quoteMint, qtp);
  const fee = [cfgIx, vaultAtaIx, updIx];
  if (x.candidate === "B") return { instructions: [createIx, ...fee], shares };

  const ib = x.initialBuy;
  if (!ib) throw new BuildError("INITIAL_BUY_REQUIRED");
  const want = { C: "buy_v2", D: "buy_v3", F: "buy_v3", E: "buy_exact_quote_in_v3" }[x.candidate];
  if (ib.mode !== want) throw new BuildError("INITIAL_BUY_MODE_MISMATCH");

  // After the fee-sharing config exists the curve's creator is the sharing-config PDA, so the buy's
  // creator vault must be derived from it — the SDK's create+buy helper would derive it from the wallet.
  const sharing = pump.feeSharingConfigPda(mint);
  // MCPX children are never mayhem coins (create_v2 is sent with mayhemMode:false).
  const curve = { ...pump.newBondingCurve(x.global, quoteMint, null, undefined, false, x.parent.curve), creator: sharing, isMayhemMode: false };
  const quoteAmount = new BN(ib.quoteAmount);
  const tokens = await wrap("BUY_QUOTE_FAILED", () => pump.getBuyV3TokenAmountFromQuoteAmount({
    global: x.global, feeConfig: x.feeConfig, mintSupply: x.global.tokenTotalSupply, bondingCurve: curve, amount: quoteAmount, curveBaseTokenBalance: curve.realTokenReserves,
  }));
  if (tokens.isZero()) throw new BuildError("BUY_QUOTE_FAILED", "zero_tokens");
  const slippage = ib.slippageBps / 100;
  const common = { bondingCurve: curve, associatedUserAccountInfo: null, mint, user: creator, amount: tokens, quoteAmount, slippage, tokenProgram: PROGRAMS.token2022, quoteTokenProgram: qtp };

  let buy;
  if (x.candidate === "C") {
    const all = await wrap("BUY_NOT_BUILDABLE", () => sdk.createV2AndBuyV2Instructions({
      global: x.global, mint, name: x.name, symbol: x.symbol, uri: x.uri, creator: sharing, user: creator,
      amount: tokens, quoteAmount, mayhemMode: false, quoteMint, quoteTokenProgram: qtp, pumpQuote: x.parent.accounts, slippage,
    }));
    buy = all.filter((ix) => instructionName(ix) !== "create_v2");
    if (buy.length !== all.length - 1) throw new BuildError("BUY_NOT_BUILDABLE", "create_v2_not_isolated");
  } else if (x.candidate === "E") {
    buy = await wrap("BUY_NOT_BUILDABLE", () => sdk.buyExactQuoteInV3Instructions(common));
  } else {
    buy = await wrap("BUY_NOT_BUILDABLE", () => sdk.buyV3Instructions(common));
  }
  if (!buy.some((ix) => instructionName(ix) === want)) throw new BuildError("BUY_NOT_BUILDABLE", "buy_instruction_missing");

  let pre = [];
  if (x.candidate === "F") {
    pre = shares.map((s) => spl.createAssociatedTokenAccountIdempotentInstruction(
      creator, spl.getAssociatedTokenAddressSync(quoteMint, s.address, true, qtp), s.address, quoteMint, qtp));
  }
  return { instructions: [createIx, ...pre, ...fee, ...buy], shares, buyTokens: tokens.toString(), sharingConfig: sharing.toBase58() };
}

/** First-fee ordering evidence: no buy precedes update_fee_shares_v2. */
export function feeFirst(ixs) {
  const names = ixs.map(instructionName);
  const upd = names.indexOf("update_fee_shares_v2"), cfg = names.indexOf("create_fee_sharing_config"), cre = names.indexOf("create_v2");
  const firstBuy = names.findIndex((n) => n.startsWith("buy"));
  return cre === 0 && cfg > cre && upd > cfg && (firstBuy === -1 || firstBuy > upd);
}

/**
 * Accounts eligible for a pre-warmed lookup table: present in two candidates built for different
 * creators/mints (so launch-independent), never signers, never invoked program IDs.
 */
export function launchIndependentAccounts(ixsX, ixsY) {
  const progs = new Set([...ixsX, ...ixsY].map((ix) => ix.programId.toBase58()));
  const nonSigner = (ixs) => new Set(ixs.flatMap((ix) => ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58())));
  const a = nonSigner(ixsX), b = nonSigner(ixsY);
  return [...a].filter((k) => b.has(k) && !progs.has(k)).sort();
}

const U64_MAX = 18446744073709551615n;
/** Lookup-table readiness: active (never deactivated), warmed (extended before currentSlot), ≤256 entries, contains the expected keys. */
export function verifyAlt(alt, currentSlot, expected) {
  const st = alt?.state;
  if (!st) return { ok: false, code: "ALT_INVALID", detail: "missing" };
  if (BigInt(st.deactivationSlot) !== U64_MAX) return { ok: false, code: "ALT_INVALID", detail: "deactivated" };
  if (!(Number(st.lastExtendedSlot) < Number(currentSlot))) return { ok: false, code: "ALT_INVALID", detail: "not_warmed" };
  if (st.addresses.length > 256) return { ok: false, code: "ALT_INVALID", detail: "too_many" };
  const have = new Set(st.addresses.map((a) => a.toBase58()));
  const absent = expected.filter((k) => !have.has(k));
  if (absent.length) return { ok: false, code: "ALT_INVALID", detail: "missing_entries", missing: absent.length };
  return { ok: true };
}
