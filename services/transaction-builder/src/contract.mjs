// Strict, versioned request contracts. Unknown fields are refused — callers can never supply RPC URLs,
// program IDs, lookup tables, fee recipients, share percentages or signers.
import { isPubkey } from "./sdk.mjs";

export const PREPARE_SCHEMA = "mcpx.launch.prepare.v1";
export const INSPECT_SCHEMA = "mcpx.launch.inspect.v1";
export const BUY_MODES = Object.freeze(["buy_v2", "buy_v3", "buy_exact_quote_in_v3"]);
export const FORMATS = Object.freeze(["legacy", "v0", "v0_alt"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keysExact = (o, ks) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...ks].sort().join(",");
const bad = (field) => ({ ok: false, code: "INVALID_REQUEST", field });

export function validatePrepare(b) {
  const K = ["schema", "idempotencyKey", "creator", "mint", "name", "symbol", "uri", "initialBuy", "format"];
  if (!keysExact(b, K) && !keysExact(b, [...K, "rehearsal"])) return bad("fields");
  if ("rehearsal" in b && b.rehearsal !== "SOL") return bad("rehearsal");
  if (b.schema !== PREPARE_SCHEMA) return bad("schema");
  if (typeof b.idempotencyKey !== "string" || !UUID.test(b.idempotencyKey)) return bad("idempotencyKey");
  if (!isPubkey(b.creator)) return bad("creator");
  if (!isPubkey(b.mint) || b.mint === b.creator) return bad("mint");
  if (typeof b.name !== "string" || b.name.trim() !== b.name || b.name.length < 1 || b.name.length > 32 || /[\u0000-\u001f]/.test(b.name)) return bad("name");
  if (typeof b.symbol !== "string" || !/^[A-Za-z0-9]{1,10}$/.test(b.symbol)) return bad("symbol");
  if (typeof b.uri !== "string" || b.uri.length > 200 || !/^https:\/\/[^\s]+$/.test(b.uri)) return bad("uri");
  if (!FORMATS.includes(b.format)) return bad("format");
  if (b.initialBuy !== null) {
    const ib = b.initialBuy;
    if (!keysExact(ib, ["mode", "quoteAmount", "slippageBps"])) return bad("initialBuy");
    if (!BUY_MODES.includes(ib.mode)) return bad("initialBuy.mode");
    if (typeof ib.quoteAmount !== "string" || !/^[1-9][0-9]{0,19}$/.test(ib.quoteAmount) || BigInt(ib.quoteAmount) > 18446744073709551615n) return bad("initialBuy.quoteAmount");
    if (!Number.isInteger(ib.slippageBps) || ib.slippageBps < 1 || ib.slippageBps > 1000) return bad("initialBuy.slippageBps");
  }
  return { ok: true, value: b };
}

export function validateInspect(b) {
  if (!keysExact(b, ["schema", "messageBase64", "binding", "bindingMac"])) return bad("fields");
  if (b.schema !== INSPECT_SCHEMA) return bad("schema");
  if (typeof b.messageBase64 !== "string" || b.messageBase64.length > 4000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.messageBase64)) return bad("messageBase64");
  if (typeof b.bindingMac !== "string" || !/^[0-9a-f]{64}$/.test(b.bindingMac)) return bad("bindingMac");
  if (!b.binding || typeof b.binding !== "object" || Array.isArray(b.binding)) return bad("binding");
  return { ok: true, value: b };
}

export const PREPARE_BUY_SCHEMA = "mcpx.launch.prepare-buy.v1";
export const STATUS_SCHEMA = "mcpx.launch.status.v1";
export const SEPARATE_BUY_MODES = Object.freeze(["buy_v3", "buy_exact_quote_in_v3"]);

/** Second, separate transaction: only after creation + final fee config are verified on chain. */
export function validatePrepareBuy(b) {
  const KB = ["schema", "idempotencyKey", "creator", "mint", "mode", "quoteAmount", "slippageBps", "format"];
  if (!keysExact(b, KB) && !keysExact(b, [...KB, "rehearsal"])) return bad("fields");
  if ("rehearsal" in b && b.rehearsal !== "SOL") return bad("rehearsal");
  if (b.schema !== PREPARE_BUY_SCHEMA) return bad("schema");
  if (typeof b.idempotencyKey !== "string" || !UUID.test(b.idempotencyKey)) return bad("idempotencyKey");
  if (!isPubkey(b.creator)) return bad("creator");
  if (!isPubkey(b.mint) || b.mint === b.creator) return bad("mint");
  if (!SEPARATE_BUY_MODES.includes(b.mode)) return bad("mode");
  if (typeof b.quoteAmount !== "string" || !/^[1-9][0-9]{0,19}$/.test(b.quoteAmount) || BigInt(b.quoteAmount) > 18446744073709551615n) return bad("quoteAmount");
  if (!Number.isInteger(b.slippageBps) || b.slippageBps < 1 || b.slippageBps > 1000) return bad("slippageBps");
  if (b.format !== "legacy" && b.format !== "v0") return bad("format");
  return { ok: true, value: b };
}

export function validateStatus(b) {
  if (!keysExact(b, ["schema", "creator", "mint"]) && !keysExact(b, ["schema", "creator", "mint", "rehearsal"])) return bad("fields");
  if ("rehearsal" in b && b.rehearsal !== "SOL") return bad("rehearsal");
  if (b.schema !== STATUS_SCHEMA) return bad("schema");
  if (!isPubkey(b.creator)) return bad("creator");
  if (!isPubkey(b.mint)) return bad("mint");
  return { ok: true, value: b };
}
