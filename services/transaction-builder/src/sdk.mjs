// Single loading point for the pinned official Pump.fun SDK. Its ESM build fails to import under
// Node 22 (named BN export from a CJS dependency), so the CJS build is loaded via createRequire.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

export const pump = require("@pump-fun/pump-sdk");
export const web3 = require("@solana/web3.js");
export const spl = require("@solana/spl-token");
export const BN = require("bn.js");
// Packages don't all export package.json; read the installed manifests directly (exact pinned versions).
const ver = (p) => JSON.parse(readFileSync(new URL(`../node_modules/${p}/package.json`, import.meta.url), "utf8")).version;
export const SDK_VERSIONS = Object.freeze(Object.fromEntries(
  ["@pump-fun/pump-sdk", "@pump-fun/pump-swap-sdk", "@coral-xyz/anchor", "@solana/web3.js", "@solana/spl-token"].map((p) => [p, ver(p)])));

const { PublicKey } = web3;
export const PROGRAMS = Object.freeze({
  pump: pump.PUMP_PROGRAM_ID,
  pumpFees: pump.PUMP_FEE_PROGRAM_ID,
  pumpAmm: pump.PUMP_AMM_PROGRAM_ID,
  system: web3.SystemProgram.programId,
  computeBudget: web3.ComputeBudgetProgram.programId,
  token: spl.TOKEN_PROGRAM_ID,
  token2022: spl.TOKEN_2022_PROGRAM_ID,
  ata: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
});
// Pinned mainnet IDs the SDK must still report; a silent SDK change fails startup, not a launch.
export const EXPECTED_PROGRAM_IDS = Object.freeze({
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpFees: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  pumpAmm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
});
export function programIdsPinned() {
  return Object.entries(EXPECTED_PROGRAM_IDS).every(([k, v]) => PROGRAMS[k].toBase58() === v);
}

// Offline Anchor programs (no network at construction) used for instruction names and decoding.
const offline = new web3.Connection("http://127.0.0.1:1");
export const pumpProgram = pump.getPumpProgram(offline);
export const feeProgram = pump.getPumpFeeProgram(offline);

const snake = (n) => n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const disc = (idl) => new Map(idl.instructions.map((i) => [Buffer.from(i.discriminator).toString("hex"), snake(i.name)]));
const PUMP_DISC = disc(pumpProgram.idl);
const FEE_DISC = disc(feeProgram.idl);

export function instructionName(ix) {
  const p = ix.programId.toBase58();
  const d = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
  if (p === PROGRAMS.pump.toBase58()) return PUMP_DISC.get(d) ?? "pump:unknown";
  if (p === PROGRAMS.pumpFees.toBase58()) return FEE_DISC.get(d) ?? "pump_fees:unknown";
  if (p === PROGRAMS.ata.toBase58()) return ix.data.length === 0 ? "ata_create" : ix.data[0] === 1 ? "ata_create_idempotent" : "ata:other";
  if (p === PROGRAMS.computeBudget.toBase58()) return "compute_budget";
  if (p === PROGRAMS.system.toBase58()) return "system";
  if (p === PROGRAMS.token.toBase58() || p === PROGRAMS.token2022.toBase58()) return "token";
  return "unknown_program";
}

export const isPubkey = (s) => {
  if (typeof s !== "string" || s.length < 32 || s.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
};
