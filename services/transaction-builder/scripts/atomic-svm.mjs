// READ-ONLY evidence (operator tool). Executes the COMPLETE atomic child-creation transaction
//   create_v2 → create_fee_sharing_config → update_fee_shares_v2 (60/25/15)
// as ONE v0 transaction inside a local Solana VM (LiteSVM) whose programs and accounts are cloned
// byte-for-byte from mainnet at a stated slot. The lookup table exists only inside the local VM.
// Nothing is signed with a real key, sent, or written on chain.
//
// Usage: node scripts/atomic-svm.mjs <STAND_IN_PARENT_MINT> [RPC_URL]
// Needs `litesvm` resolvable (NODE_PATH) — it is intentionally NOT a builder dependency.
import { createRequire } from "node:module";
import { pump, web3, spl, instructionName } from "../src/sdk.mjs";
import { assessParent } from "../src/parent.mjs";
import { compile, launchIndependentAccounts, PACKET_LIMIT } from "../src/build.mjs";
import { FEE_SPLIT_BPS } from "../src/config.mjs";

const req = createRequire(import.meta.url);
const { LiteSVM } = req(req.resolve("litesvm", { paths: (process.env.NODE_PATH ?? "").split(":").filter(Boolean) }));
const internal = req(req.resolve("litesvm/dist/internal", { paths: (process.env.NODE_PATH ?? "").split(":").filter(Boolean) }));

const [Qarg, rpc = "https://api.mainnet-beta.solana.com"] = process.argv.slice(2);
if (!Qarg) { console.error("usage: atomic-svm.mjs <STAND_IN_PARENT_MINT> [RPC_URL]"); process.exit(2); }
const c = new web3.Connection(rpc, "finalized"), online = new pump.OnlinePumpSdk(c), sdk = pump.PUMP_SDK;
const { PublicKey, Keypair } = web3;
const UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const ALT_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");
const Q = new PublicKey(Qarg);

const g = await online.fetchGlobal();
const qtp = (await c.getAccountInfo(Q)).owner;
const parent = assessParent({ global: g, quoteMint: Q.toBase58(), quoteTokenProgram: qtp, pumpQuote: await online.fetchPumpQuote(Q, { global: g }) });
const out = { label: "LOCAL_SVM_FULL_ATOMIC_EXECUTION_STAND_IN_PARENT_NOT_MCP", standInParent: Q.toBase58(), parent: parent.ok ? parent.scenario : parent.code };
if (!parent.ok) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

const k = () => Keypair.generate().publicKey;
const creator = k(), ops = k(), plat = k(), mint = k();
const build = async (cr, mt) => {
  const create = await sdk.createV2Instruction({ mint: mt, name: "Sim Child", symbol: "SIMC", uri: "https://mcpx.fun/m/sim.json", creator: cr, user: cr, mayhemMode: false, quoteMint: Q, quoteTokenProgram: qtp, pumpQuote: parent.accounts });
  const cfg = await sdk.createFeeSharingConfig({ creator: cr, mint: mt, pool: null });
  const upd = await sdk.updateFeeSharesV2({ authority: cr, mint: mt, currentShareholders: [cr], newShareholders: [{ address: cr, shareBps: FEE_SPLIT_BPS.creator }, { address: ops, shareBps: FEE_SPLIT_BPS.ops }, { address: plat, shareBps: FEE_SPLIT_BPS.platform }], quoteMint: Q, quoteTokenProgram: qtp, bondingCurveComplete: false });
  if (!process.env.PRE_VAULT_ATA) return [create, cfg, upd];
  // Non-native quote: update_fee_shares_v2's inner distribute reads the sharing-config creator
  // vault's quote ATA, which a brand-new coin does not have yet. Create it (idempotent) first.
  const vault = pump.creatorVaultPda(pump.feeSharingConfigPda(mt));
  const vaultAta = spl.getAssociatedTokenAddressSync(Q, vault, true, qtp);
  const pre = spl.createAssociatedTokenAccountIdempotentInstruction(cr, vaultAta, vault, Q, qtp);
  return [create, cfg, pre, upd];
};
const ixs = await build(creator, mint);
const other = await build(k(), k());
const altKeys = launchIndependentAccounts(ixs, other).map((a) => new PublicKey(a));

// Clone every account the transaction touches (plus program data) at one finalized slot.
const all = [...new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((x) => x.pubkey.toBase58())]))].map((a) => new PublicKey(a));
const slot = await c.getSlot("finalized");
const infos = await c.getMultipleAccountsInfo(all, { commitment: "finalized" });
const svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false);
const clock = svm.getClock();
svm.setClock(new internal.Clock(BigInt(slot), clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, BigInt(Math.floor(Date.now() / 1000))));
const cloned = { programs: [], accounts: 0, absent: 0 };
for (let i = 0; i < all.length; i++) {
  const a = all[i], info = infos[i];
  if (!info) { cloned.absent++; continue; }
  if (info.executable) {
    if (info.owner.toBase58() === UPGRADEABLE) {
      const pd = new PublicKey(info.data.subarray(4, 36));
      const pdi = await c.getAccountInfo(pd, "finalized");
      svm.addProgram(a.toBase58(), new Uint8Array(pdi.data.subarray(45)));
      cloned.programs.push(a.toBase58());
    }
    continue; // native/builtin programs come with the VM
  }
  svm.inner.setAccount(a.toBytes(), new internal.Account(BigInt(info.lamports), new Uint8Array(info.data), info.owner.toBytes(), false, 0n));
  cloned.accounts++;
}
// Payer funded locally (realistic balance, not a real wallet).
svm.inner.setAccount(creator.toBytes(), new internal.Account(10_000_000_000n, new Uint8Array(), web3.SystemProgram.programId.toBytes(), false, 0n));

// Local-only lookup table with the launch-independent entries (same list alt-plan.mjs would provision).
const altKey = k();
const hdr = Buffer.alloc(56);
hdr.writeUInt32LE(1, 0); hdr.writeBigUInt64LE(18446744073709551615n, 4); hdr.writeBigUInt64LE(BigInt(slot - 10), 12); hdr.writeUInt8(0, 20); hdr.writeUInt8(0, 21);
const altData = Buffer.concat([hdr, ...altKeys.map((p) => p.toBuffer())]);
svm.inner.setAccount(altKey.toBytes(), new internal.Account(10_000_000n, new Uint8Array(altData), ALT_PROGRAM.toBytes(), false, 0n));
const alt = new web3.AddressLookupTableAccount({ key: altKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: slot - 10, lastExtendedSlotStartIndex: 0, addresses: altKeys } });

const { blockhash } = await c.getLatestBlockhash("finalized");
const noAlt = compile(ixs, creator, blockhash, "v0");
const withAlt = compile(ixs, creator, blockhash, "v0", [alt]);
const tx = new web3.VersionedTransaction(web3.VersionedMessage.deserialize(withAlt.messageBytes));
const res = svm.inner.sendVersionedTransaction(tx.serialize());
const failed = typeof res.err === "function";
const meta = failed ? res.meta() : res;
out.slot = slot; out.cloned = cloned; out.altEntries = altKeys.length;
out.tx = { instructions: ixs.map((ix) => instructionName(ix) ?? ix.programId.toBase58()), bytesWithoutAlt: noAlt.size, bytesWithLocalAlt: withAlt.size, limit: PACKET_LIMIT, signers: withAlt.signers.map((s) => (s === creator.toBase58() ? "CREATOR" : s === mint.toBase58() ? "NEW_MINT" : "OTHER")), staticAccounts: withAlt.staticAccounts, lookedUpAccounts: withAlt.lookedUpAccounts };
out.execution = failed ? "FAIL" : "PASS";
out.err = failed ? String(res.err()) : null;
out.computeUnits = Number(meta.computeUnitsConsumed());
out.logsTail = meta.logs().slice(process.env.FULL_LOGS ? 0 : -6);
if (!failed) {
  const sc = pump.feeSharingConfigPda(mint);
  const raw = svm.inner.getAccount(sc.toBytes());
  const cfg = sdk.decodeSharingConfig({ data: Buffer.from(raw.data()), owner: new PublicKey(raw.owner()), lamports: Number(raw.lamports()), executable: false });
  const role = (p) => (p.equals(creator) ? "CREATOR" : p.equals(ops) ? "TOOL_OPS" : p.equals(plat) ? "PLATFORM" : "UNEXPECTED");
  out.sharingConfig = { exists: true, mintMatches: cfg.mint.equals(mint), adminRevoked: cfg.adminRevoked, shareholders: cfg.shareholders.map((s) => ({ role: role(s.address), bps: s.shareBps })) };
  const bcRaw = svm.inner.getAccount(pump.bondingCurvePda(mint).toBytes());
  const bc = sdk.decodeBondingCurve({ data: Buffer.from(bcRaw.data()), owner: new PublicKey(bcRaw.owner()), lamports: Number(bcRaw.lamports()), executable: false });
  out.bondingCurve = { creatorIsSharingConfig: bc.creator.equals(sc), isMayhemMode: bc.isMayhemMode, quoteMintMatches: bc.quoteMint ? bc.quoteMint.equals(Q) : null, depth: bc.depth };
  const after = svm.inner.getAccount(creator.toBytes());
  out.creatorLamportsSpent = (10_000_000_000n - BigInt(after.lamports())).toString();
}
console.log(JSON.stringify(out, null, 1));
