// Operator tool: create + fill the MCPX address lookup table, owned and paid for by the deployer wallet.
// Run on the operator's own machine only — the keypair file must never be copied to the website,
// builder or worker. Dry run by default; add --send to actually create it.
//
// Usage:
//   node scripts/alt-create.mjs <MCP_MINT> <OPS_RECIPIENT> <PLATFORM_RECIPIENT> <DEPLOYER_KEYPAIR_JSON> [RPC_URL] [--send]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { web3 } from "../src/sdk.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--send");
const SEND = process.argv.includes("--send");
const [mint, ops, plat, keyPath, rpc = "https://api.mainnet-beta.solana.com"] = args;
if (!mint || !ops || !plat || !keyPath) { console.error("usage: alt-create.mjs <MCP_MINT> <OPS> <PLATFORM> <DEPLOYER_KEYPAIR_JSON> [RPC] [--send]"); process.exit(2); }

const plan = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./alt-plan.mjs", import.meta.url)), mint, ops, plat, rpc], { encoding: "utf8" }));
if (plan.blocked) { console.log(JSON.stringify({ result: "BLOCKED", reason: plan.blocked })); process.exit(1); }
const addresses = plan.entries.map((e) => new web3.PublicKey(e.address));

const authority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const c = new web3.Connection(rpc, "confirmed");
const balance = await c.getBalance(authority.publicKey);
const summary = { authority: authority.publicKey.toBase58(), entries: plan.count, rentLamports: plan.rentExemptLamports, balanceLamports: balance, txSizeWithAlt: plan.bSizeWithAlt, limit: 1232 };
if (!SEND) { console.log(JSON.stringify({ result: "DRY_RUN_NOTHING_SENT", ...summary, entries: plan.entries }, null, 1)); process.exit(0); }
if (balance < plan.rentExemptLamports + 50_000) { console.log(JSON.stringify({ result: "BLOCKED", reason: "INSUFFICIENT_SOL", ...summary })); process.exit(1); }
if (plan.bSizeWithAlt > 1232) { console.log(JSON.stringify({ result: "BLOCKED", reason: "STILL_TOO_LARGE", ...summary })); process.exit(1); }

const send = async (ixs) => {
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("finalized");
  const msg = new web3.TransactionMessage({ payerKey: authority.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg); tx.sign([authority]);
  const sig = await c.sendTransaction(tx, { maxRetries: 5 });
  await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
  return sig;
};

const recentSlot = await c.getSlot("finalized");
const [createIx, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot });
const createSig = await send([createIx]);
const extendSigs = [];
for (let i = 0; i < addresses.length; i += 20) {
  extendSigs.push(await send([web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: authority.publicKey, payer: authority.publicKey, addresses: addresses.slice(i, i + 20) })]));
}
await new Promise((r) => setTimeout(r, 2000)); // warm-up: at least one slot
const onChain = (await c.getAddressLookupTable(table)).value;
const match = !!onChain && onChain.state.addresses.length === addresses.length && onChain.state.addresses.every((a, i) => a.equals(addresses[i]));
console.log(JSON.stringify({ result: match ? "CREATED_AND_VERIFIED" : "CREATED_MISMATCH", lookupTable: table.toBase58(), createSig, extendSigs, ...summary,
  next: match ? `Set MCPX_LOOKUP_TABLE=${table.toBase58()} on Builder #2 only.` : "Do not configure; compare entries with the plan." }, null, 1));
