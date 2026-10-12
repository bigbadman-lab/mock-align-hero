// READ-ONLY ALT provisioning plan (operator tool). Creates nothing.
// Usage: node scripts/alt-plan.mjs <PARENT_MINT> <OPS_RECIPIENT> <PLATFORM_RECIPIENT> [RPC_URL]
import { pump, web3, spl, PROGRAMS } from "../src/sdk.mjs";
import { assessParent } from "../src/parent.mjs";
import { launchIndependentAccounts, compile } from "../src/build.mjs";

const [Qa, opsA, platA, rpc = "https://api.mainnet-beta.solana.com"] = process.argv.slice(2);
if (!Qa || !opsA || !platA) { console.error("usage: alt-plan.mjs <PARENT_MINT> <OPS> <PLATFORM> [RPC]"); process.exit(2); }
const c = new web3.Connection(rpc, "confirmed"), online = new pump.OnlinePumpSdk(c), sdk = pump.PUMP_SDK;
const Q = new web3.PublicKey(Qa), ops = new web3.PublicKey(opsA), plat = new web3.PublicKey(platA);
const g = await online.fetchGlobal();
const qtp = (await c.getAccountInfo(Q)).owner;
const parent = assessParent({ global: g, quoteMint: Qa, quoteTokenProgram: qtp, pumpQuote: await online.fetchPumpQuote(Q, { global: g }) });
if (!parent.ok) { console.log(JSON.stringify({ blocked: parent.code })); process.exit(0); }

const b = async () => {
  const creator = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  return { creator, ixs: [
    await sdk.createV2Instruction({ mint, name: "Plan", symbol: "PLAN", uri: "https://mcpx.fun/p.json", creator, user: creator, mayhemMode: false, quoteMint: Q, quoteTokenProgram: qtp, pumpQuote: parent.accounts }),
    await sdk.createFeeSharingConfig({ creator, mint, pool: null }),
    await sdk.updateFeeSharesV2({ authority: creator, mint, currentShareholders: [creator], newShareholders: [{ address: creator, shareBps: 6000 }, { address: ops, shareBps: 2500 }, { address: plat, shareBps: 1500 }], quoteMint: Q, quoteTokenProgram: qtp, bondingCurveComplete: false }),
  ] };
};
const x = await b(), y = await b();
const addrs = launchIndependentAccounts(x.ixs, y.ixs);
const known = new Map([
  [pump.GLOBAL_PDA.toBase58(), "pump Global"], [pump.PUMP_EVENT_AUTHORITY_PDA.toBase58(), "pump event authority"],
  [pump.PUMP_FEE_CONFIG_PDA.toBase58(), "pump-fees FeeConfig"], [pump.PUMP_FEE_EVENT_AUTHORITY_PDA.toBase58(), "pump-fees event authority"],
  [pump.FEE_PROGRAM_GLOBAL_PDA.toBase58(), "pump-fees Global"], [Qa, "parent quote mint ($MCP)"], [pump.bondingCurvePda(Q).toBase58(), "parent bonding curve"],
  [opsA, "25% ops recipient"], [platA, "15% platform recipient"],
  [spl.getAssociatedTokenAddressSync(Q, ops, true, qtp).toBase58(), "ops quote ATA"], [spl.getAssociatedTokenAddressSync(Q, plat, true, qtp).toBase58(), "platform quote ATA"],
  ...Object.entries(PROGRAMS).map(([k, v]) => [v.toBase58(), `${k} program (account, not invoked)`]),
]);
const rentLamports = await c.getMinimumBalanceForRentExemption(56 + 32 * addrs.length);
const alt = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new web3.PublicKey(a)) } });
const { blockhash } = await c.getLatestBlockhash();
console.log(JSON.stringify({
  label: "ALT_PLAN_READ_ONLY_NOTHING_CREATED", parent: parent.scenario, entries: addrs.map((a) => ({ address: a, role: known.get(a) ?? "launch-independent protocol account" })),
  count: addrs.length, rentExemptLamports: rentLamports, txFeesLamports: "5000 per signature per transaction (create + 1 extend ⇒ 10000 base, plus any priority fee)",
  bSizeWithAlt: compile(x.ixs, x.creator, blockhash, "v0", [alt]).size, bSizeWithoutAlt: compile(x.ixs, x.creator, blockhash, "v0").size,
}, null, 1));
