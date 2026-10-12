// Environment validation. Fee split and recipients are server-fixed; nothing here comes from requests.
import { isPubkey } from "./sdk.mjs";

export const FEE_SPLIT_BPS = Object.freeze({ creator: 6000, ops: 2500, platform: 1500 });
if (FEE_SPLIT_BPS.creator + FEE_SPLIT_BPS.ops + FEE_SPLIT_BPS.platform !== 10000) throw new Error("fee split must total 10000");

/** @returns {{state:"NOT_CONFIGURED"|"READY_FOR_PREPARE", missing:string[], invalid:string[], secret?:string, rpcUrl?:string, quoteMint:string|null, opsRecipient?:string, platformRecipient?:string, port:number}} */
export function loadConfig(env) {
  const missing = [], invalid = [];
  const secret = env.MCPX_TX_BUILDER_SECRET;
  if (!secret) missing.push("MCPX_TX_BUILDER_SECRET"); else if (secret.length < 32) invalid.push("MCPX_TX_BUILDER_SECRET");
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) missing.push("SOLANA_RPC_URL"); else if (!/^https:\/\//.test(rpcUrl)) invalid.push("SOLANA_RPC_URL");
  const ops = env.MCPX_FEE_OPS_RECIPIENT, plat = env.MCPX_FEE_PLATFORM_RECIPIENT;
  if (!ops) missing.push("MCPX_FEE_OPS_RECIPIENT"); else if (!isPubkey(ops)) invalid.push("MCPX_FEE_OPS_RECIPIENT");
  if (!plat) missing.push("MCPX_FEE_PLATFORM_RECIPIENT"); else if (!isPubkey(plat)) invalid.push("MCPX_FEE_PLATFORM_RECIPIENT");
  if (ops && plat && ops === plat) invalid.push("MCPX_FEE_RECIPIENTS_DUPLICATE");
  // Optional: absence is a real economic dependency (no canonical $MCP mint), not a config error.
  const q = env.MCPX_QUOTE_MINT || null;
  if (q && !isPubkey(q)) invalid.push("MCPX_QUOTE_MINT");
  // Optional: MCPX-owned, pre-warmed address lookup table. Not created in 04-A (that is an on-chain write).
  const lut = env.MCPX_LOOKUP_TABLE || null;
  if (lut && !isPubkey(lut)) invalid.push("MCPX_LOOKUP_TABLE");
  const state = missing.length || invalid.length ? "NOT_CONFIGURED" : "READY_FOR_PREPARE";
  return { state, missing, invalid, secret, rpcUrl, quoteMint: q && isPubkey(q) ? q : null, lookupTable: lut && isPubkey(lut) ? lut : null, opsRecipient: ops, platformRecipient: plat, port: Number(env.PORT) || 10000 };
}
