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
  // Required: the native $MCP deployer (public key only) may never be a child fee recipient or creator.
  const dep = env.MCPX_NATIVE_DEPLOYER_PUBLIC_KEY || null;
  if (!dep) missing.push("MCPX_NATIVE_DEPLOYER_PUBLIC_KEY");
  else if (!isPubkey(dep)) invalid.push("MCPX_NATIVE_DEPLOYER_PUBLIC_KEY");
  if (dep && (dep === ops || dep === plat)) invalid.push("MCPX_FEE_RECIPIENT_IS_NATIVE_DEPLOYER");
  // Optional: absence is a real economic dependency (no canonical $MCP mint), not a config error.
  const q = env.MCPX_QUOTE_MINT || null;
  if (q && !isPubkey(q)) invalid.push("MCPX_QUOTE_MINT");
  // Optional: MCPX-owned, pre-warmed address lookup table. Not created in 04-A (that is an on-chain write).
  // One-time SOL rehearsal: the single creator wallet allowed to build a SOL-paired candidate. Unset = off.
  const solc = env.MCPX_SOL_REHEARSAL_CREATOR || null;
  if (solc && (!isPubkey(solc) || solc === dep || solc === ops || solc === plat)) invalid.push("MCPX_SOL_REHEARSAL_CREATOR");
  const lut = env.MCPX_LOOKUP_TABLE || null;
  if (lut && !isPubkey(lut)) invalid.push("MCPX_LOOKUP_TABLE");
  // The builder never holds keys: any private-key-shaped variable refuses readiness.
  for (const k of Object.keys(env)) if (/PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|SEED_PHRASE/i.test(k) && env[k]) invalid.push(`FORBIDDEN_KEY_MATERIAL:${k}`);
  const state = missing.length || invalid.length ? "NOT_CONFIGURED" : "READY_FOR_PREPARE";
  return { state, missing, invalid, secret, rpcUrl, quoteMint: q && isPubkey(q) ? q : null, lookupTable: lut && isPubkey(lut) ? lut : null, opsRecipient: ops, platformRecipient: plat, nativeDeployer: dep && isPubkey(dep) ? dep : null, solRehearsalCreator: solc && !invalid.includes("MCPX_SOL_REHEARSAL_CREATOR") ? solc : null, port: Number(env.PORT) || 10000 };
}
