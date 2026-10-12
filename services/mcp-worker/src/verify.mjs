// Transaction Verifier v1 — read-only retrieval of one mainnet transaction via getTransaction.
// "Verified" means: retrieved from the configured RPC at a stated commitment. It does NOT
// re-verify signatures cryptographically, judge safety, or attribute ownership.
import { RpcError, rpcFetch, formatUnits } from "./inspect.mjs";

export const TV_SCHEMA = "mcpx.tool-execution.transaction-verifier.v1";
export const TV_TOOL_ID = "transaction_verifier";
export const MAX_SUPPORTED_TX_VERSION = 0; // v1 not advertised until provider support is verified live
const MAX_PROGRAMS = 64;
const MAX_SIGNERS = 32;
const MAX_ERR_DETAIL = 500;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Decoded byte length of a base58 string, or -1 if not base58. */
export function base58Length(s) {
  let n = 0n;
  for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) return -1; n = n * 58n + BigInt(i); }
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  for (const c of s) { if (c === "1") bytes++; else break; }
  return bytes;
}
/** Returns `s` if it is an exact 64-byte base58 signature (no whitespace), else null. */
export function parseSignature(s) {
  if (typeof s !== "string" || s.length < 64 || s.length > 88) return null;
  return base58Length(s) === 64 ? s : null;
}

const isPk = (v) => typeof v === "string" && v.length >= 32 && v.length <= 44 && base58Length(v) === 32;

export function describeError(err) {
  if (err === null || err === undefined) return null;
  let detail;
  try { detail = JSON.stringify(err); } catch { detail = "[unserializable]"; }
  if (detail.length > MAX_ERR_DETAIL) detail = detail.slice(0, MAX_ERR_DETAIL) + "…";
  let summary = "Execution failed";
  if (typeof err === "string") summary = `Execution failed: ${err}`;
  else if (err && Array.isArray(err.InstructionError) && Number.isInteger(err.InstructionError[0])) {
    const [i, e] = err.InstructionError;
    const what = typeof e === "string" ? e : e && typeof e === "object" && "Custom" in e ? `custom program error ${e.Custom}` : e && typeof e === "object" ? Object.keys(e)[0] : "unknown";
    summary = `Instruction #${i} failed: ${what}`;
  } else if (err && typeof err === "object") summary = `Execution failed: ${Object.keys(err)[0] ?? "unknown"}`;
  return { summary: summary.slice(0, 200), detail };
}

/** Pure normalizer over a jsonParsed getTransaction result. Throws bad_response when shape is untrustworthy. */
export function normalizeTransaction(tx, confirmation) {
  if (!tx || typeof tx !== "object" || !Number.isSafeInteger(tx.slot)) throw new RpcError("bad_response", "transaction missing slot");
  const version = tx.version === undefined || tx.version === "legacy" ? "legacy" : tx.version === 0 ? 0 : null;
  if (version === null) throw new RpcError("unsupported_version", "unsupported transaction version");
  const msg = tx.transaction?.message;
  const keys = Array.isArray(msg?.accountKeys) ? msg.accountKeys : null;
  let feePayer = null, signers = null, accountCount = null, loadedAddressCount = null;
  if (keys && keys.every((k) => k && isPk(k.pubkey) && typeof k.signer === "boolean")) {
    accountCount = keys.length;
    loadedAddressCount = keys.filter((k) => k.source === "lookupTable").length;
    const s = keys.filter((k) => k.signer).map((k) => k.pubkey);
    if (s.length > 0 && keys[0].signer) { feePayer = keys[0].pubkey; signers = s.slice(0, MAX_SIGNERS); }
  }
  let programIds = null, topLevelInstructionCount = null;
  if (Array.isArray(msg?.instructions) && msg.instructions.every((ix) => ix && isPk(ix.programId))) {
    topLevelInstructionCount = msg.instructions.length;
    programIds = [...new Set(msg.instructions.map((ix) => ix.programId))].slice(0, MAX_PROGRAMS);
  }
  const meta = tx.meta && typeof tx.meta === "object" ? tx.meta : null;
  const feeLamports = meta && Number.isSafeInteger(meta.fee) && meta.fee >= 0 ? String(meta.fee) : null;
  return {
    found: true,
    confirmation,
    execution: meta ? (meta.err === null ? "succeeded" : "failed") : "unknown",
    slot: tx.slot,
    blockTime: Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null,
    version,
    feeLamports,
    feeSol: feeLamports === null ? null : formatUnits(feeLamports, 9),
    feePayer,
    signers,
    accountCount,
    loadedAddressCount,
    programIds,
    topLevelInstructionCount,
    computeUnitsConsumed: meta && Number.isSafeInteger(meta.computeUnitsConsumed) ? meta.computeUnitsConsumed : null,
    logMessageCount: meta && Array.isArray(meta.logMessages) ? meta.logMessages.length : null,
    error: meta ? describeError(meta.err) : null,
    metaAvailable: meta !== null,
  };
}

const EMPTY = { found: false, confirmation: null, execution: null, slot: null, blockTime: null, version: null, feeLamports: null, feeSol: null, feePayer: null, signers: null, accountCount: null, loadedAddressCount: null, programIds: null, topLevelInstructionCount: null, computeUnitsConsumed: null, logMessageCount: null, error: null, metaAvailable: false };

/** At most two bounded reads: finalized, then confirmed only if finalized returned null. */
export async function verifyTransaction({ signature, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const sig = parseSignature(signature);
  if (!sig) throw new RpcError("invalid_input", "invalid signature");
  const cfg = (commitment) => [sig, { commitment, encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION }];
  let body = EMPTY;
  const fin = await rpcFetch(rpcUrl, "getTransaction", cfg("finalized"), fetchImpl, signal);
  if (fin !== null) body = normalizeTransaction(fin, "finalized");
  else {
    const conf = await rpcFetch(rpcUrl, "getTransaction", cfg("confirmed"), fetchImpl, signal);
    if (conf !== null) body = normalizeTransaction(conf, "confirmed");
  }
  return {
    schema: TV_SCHEMA, executionId, toolId: TV_TOOL_ID, network: "solana-mainnet",
    source: "Solana mainnet via configured RPC (getTransaction, jsonParsed)",
    commitmentsChecked: body.confirmation === "finalized" ? ["finalized"] : ["finalized", "confirmed"],
    maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
    signature: sig, fetchedAt: now().toISOString(), ...body,
  };
}
