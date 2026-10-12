// ISOLATED TEST FIXTURES ONLY. Global/FeeConfig are a read-only mainnet snapshot; every key and every
// parent curve below is synthetic. None of this is reachable from src/server.mjs.
import { readFileSync } from "node:fs";
import { pump, web3, BN, PROGRAMS } from "../src/sdk.mjs";

const { PublicKey, Keypair } = web3;
const load = (f) => {
  const j = JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
  return { info: { data: Buffer.from(j.dataBase64, "base64"), owner: new PublicKey(j.owner), lamports: 0, executable: false }, slot: j.slot };
};
const g = load("mainnet-global.json"), f = load("mainnet-fee-config.json");
export const SNAPSHOT_SLOT = g.slot;
export const global = pump.PUMP_SDK.decodeGlobal(g.info);
export const feeConfig = pump.PUMP_SDK.decodeFeeConfig(f.info);

export const kp = () => Keypair.generate();
export const FIXTURE_QUOTE = kp().publicKey; // synthetic stand-in for $MCP — never a production value
export const FIXTURE_OPS = kp().publicKey.toBase58();
export const FIXTURE_PLATFORM = kp().publicKey.toBase58();
export const FIXTURE_BLOCKHASH = Keypair.generate().publicKey.toBase58();

/** Synthetic parent ($MCP-like) curve in a given lifecycle state. */
export function parentFixture(kind = "active", quoteMint = FIXTURE_QUOTE) {
  const bc = { ...pump.newBondingCurve(global), depth: 0, isMayhemMode: false };
  let accounts = {};
  if (kind === "mayhem") bc.isMayhemMode = true;
  if (kind === "depth1") bc.depth = 1;
  if (kind === "awaiting") bc.complete = true;
  const curve = { mint: quoteMint, bondingCurve: bc, quoteControl: null };
  if (kind === "migrated") {
    Object.assign(bc, { complete: true, virtualTokenReserves: new BN(0), virtualQuoteReserves: new BN(0), realTokenReserves: new BN(0), realQuoteReserves: new BN(0) });
    curve.pool = { baseReserves: new BN("200000000000000"), quoteReserves: new BN("85000000000"), virtualQuoteReserves: new BN(0) };
    accounts = { pool: { pool: kp().publicKey, baseVault: kp().publicKey, quoteVault: kp().publicKey } };
  }
  return { curve, accounts };
}
export const SPL = PROGRAMS.token, T22 = PROGRAMS.token2022;
