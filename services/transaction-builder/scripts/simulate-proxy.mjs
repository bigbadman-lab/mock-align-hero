// READ-ONLY mainnet evidence (operator tool). Usage: node scripts/simulate-proxy.mjs <PROXY_PARENT_MINT> [RPC_URL]
// PROXY_PARENT_MINT is an existing depth-0 pump coin standing in for $MCP — clearly NOT $MCP.
// The payer is a public funded wallet used only as an address: sigVerify is off, nothing is signed or sent.
import { pump, web3, instructionName } from "../src/sdk.mjs";
import { assessParent } from "../src/parent.mjs";
import { compile, launchIndependentAccounts, PACKET_LIMIT } from "../src/build.mjs";

const [Qarg, rpc = "https://api.mainnet-beta.solana.com"] = process.argv.slice(2);
if (!Qarg) { console.error("usage: simulate-proxy.mjs <PROXY_PARENT_MINT> [RPC_URL]"); process.exit(2); }
const c = new web3.Connection(rpc, "confirmed"), online = new pump.OnlinePumpSdk(c), sdk = pump.PUMP_SDK;
const Q = new web3.PublicKey(Qarg);
const PAYER = new web3.PublicKey(process.env.SIM_PAYER ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const g = await online.fetchGlobal();
const qtp = (await c.getAccountInfo(Q)).owner;
const parent = assessParent({ global: g, quoteMint: Q.toBase58(), quoteTokenProgram: qtp, pumpQuote: await online.fetchPumpQuote(Q, { global: g }) });
const out = { label: "READ_ONLY_PROXY_PARENT_SIMULATION_NOT_MCP", proxyParent: Q.toBase58(), parent: parent.ok ? parent.scenario : parent.code, runs: [] };
if (!parent.ok) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

const build = async (mint, ops, plat) => {
  const create = await sdk.createV2Instruction({ mint, name: "Sim", symbol: "SIM", uri: "https://mcpx.fun/m.json", creator: PAYER, user: PAYER, mayhemMode: false, quoteMint: Q, quoteTokenProgram: qtp, pumpQuote: parent.accounts });
  const cfg = await sdk.createFeeSharingConfig({ creator: PAYER, mint, pool: null });
  const upd = await sdk.updateFeeSharesV2({ authority: PAYER, mint, currentShareholders: [PAYER], newShareholders: [{ address: PAYER, shareBps: 6000 }, { address: ops, shareBps: 2500 }, { address: plat, shareBps: 1500 }], quoteMint: Q, quoteTokenProgram: qtp, bondingCurveComplete: false });
  return { create, cfg, upd };
};
const k = () => web3.Keypair.generate().publicKey;
const mint = k(), ops = k(), plat = k();
const { create, cfg, upd } = await build(mint, ops, plat);

for (const [label, ixs] of [["create_v2", [create]], ["create_v2+create_fee_sharing_config", [create, cfg]], ["B: +update_fee_shares_v2", [create, cfg, upd]]]) {
  const { blockhash } = await c.getLatestBlockhash();
  const m = compile(ixs, PAYER, blockhash, "v0");
  const run = { label, instructions: ixs.map(instructionName), serializedBytes: m.size, limit: PACKET_LIMIT };
  if (!m.messageBytes) { run.simulation = "BLOCKED_TX_TOO_LARGE_WITHOUT_ALT"; out.runs.push(run); continue; }
  const r = await c.simulateTransaction(new web3.VersionedTransaction(web3.VersionedMessage.deserialize(m.messageBytes)), { sigVerify: false, replaceRecentBlockhash: true });
  run.simulation = r.value.err ? "FAIL" : "PASS"; run.err = r.value.err; run.unitsConsumed = r.value.unitsConsumed; run.slot = r.context.slot;
  for (const l of r.value.logs ?? []) if (l.startsWith("Program data: ")) {
    const buf = Buffer.from(l.slice(14), "base64");
    for (const d of [buf, buf.subarray(8)]) { try { const ev = sdk.decodeCreateFeeSharingConfigEvent(d); if (ev?.initialShareholders) { run.initialShareholders = ev.initialShareholders.map((s) => ({ isCreator: s.address.equals(PAYER), bps: s.shareBps })); run.adminIsCreator = ev.admin.equals(PAYER); break; } } catch {} }
  }
  out.runs.push(run);
}
// ALT sizing for B with this real parent (accounts shared by two different launches).
const second = await build(k(), ops, plat);
const addrs = launchIndependentAccounts([create, cfg, upd], [second.create, second.cfg, second.upd]).map((a) => new web3.PublicKey(a));
const alt = new web3.AddressLookupTableAccount({ key: k(), state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: addrs } });
const { blockhash } = await c.getLatestBlockhash();
out.bWithAlt = { altEntries: addrs.length, serializedBytes: compile([create, cfg, upd], PAYER, blockhash, "v0", [alt]).size, note: "ALT not on chain: size measured, simulation BLOCKED_ALT_NOT_PROVISIONED" };
console.log(JSON.stringify(out, null, 1));
