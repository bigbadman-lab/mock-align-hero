// Operator tool: the MCPX address lookup table, owned and paid for by the native deployer wallet.
// Run on the operator's own machine only — the keypair file is read only with --send and must never be
// copied to the website, builder or worker. Every mode is a dry run unless --send is given.
//
//   static <OPS> <PLATFORM> [KEYPAIR_JSON] [RPC] [--send]
//       Before $MCP exists: create the table with every launch-independent address the builder needs.
//   extend <TABLE> <MCP_MINT> <OPS> <PLATFORM> [KEYPAIR_JSON] [RPC] [--send]
//       After $MCP exists: add only the mint-dependent addresses that are missing, then verify the full set.
//   verify <TABLE> [MCP_MINT] [OPS] [PLATFORM] [RPC]
//       Read-only: check the table on mainnet (active, warmed, authority, and the expected entries).
//
// The table is never frozen (it must be extendable if $MCP migrates from its curve to a pool).
// The authority must equal MCPX_EXPECTED_AUTHORITY (default: the native deployer public key).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { web3 } from "../src/sdk.mjs";

const DEPLOYER = process.env.MCPX_EXPECTED_AUTHORITY || "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
// Live reference tokens (one on its curve, one migrated to a pool), used only to tell which addresses are
// the same for every parent. They are never put in the table unless they are also in every other plan.
const REFERENCE_PARENTS = ["8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump", "3PQxZUJoVhQV4Q3fczafyJYvdMrXyHAPPcwwc3mopump"];

const SEND = process.argv.includes("--send");
const [mode, ...a] = process.argv.slice(2).filter((x) => x !== "--send");
const out = (o) => console.log(JSON.stringify(o, null, 1));
const isKey = (s) => { try { return new web3.PublicKey(s).toBase58() === s; } catch { return false; } };

const planFor = (mint, ops, plat, rpc) => {
  const p = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./alt-plan.mjs", import.meta.url)), mint, ops, plat, rpc], { encoding: "utf8" }));
  if (p.blocked) throw new Error(`PLAN_BLOCKED:${p.blocked}`);
  return p;
};
/** Addresses present in the plan for every reference parent = independent of which token is $MCP. */
function staticPlan(ops, plat, rpc) {
  const plans = REFERENCE_PARENTS.map((m) => planFor(m, ops, plat, rpc));
  const sets = plans.map((p) => new Set(p.entries.map((e) => e.address)));
  const roles = new Map(plans[0].entries.map((e) => [e.address, e.role]));
  const addrs = [...sets[0]].filter((x) => sets.every((s) => s.has(x))).sort();
  return { entries: addrs.map((x) => ({ address: x, role: roles.get(x) })), scenarios: plans.map((p) => p.parent) };
}

async function checkOnMainnet(c, addrs) {
  const infos = [];
  for (let i = 0; i < addrs.length; i += 100) infos.push(...(await c.getMultipleAccountsInfo(addrs.slice(i, i + 100).map((x) => new web3.PublicKey(x)))));
  return addrs.map((x, i) => ({ address: x, exists: !!infos[i], owner: infos[i]?.owner.toBase58() ?? null, executable: !!infos[i]?.executable }));
}

function loadAuthority(keyPath) {
  if (!keyPath) throw new Error("KEYPAIR_REQUIRED_FOR_SEND");
  const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  if (kp.publicKey.toBase58() !== DEPLOYER) throw new Error(`AUTHORITY_MISMATCH: keypair is ${kp.publicKey.toBase58()}, expected ${DEPLOYER}`);
  return kp;
}

async function sender(c, kp) {
  return async (ixs) => {
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("finalized");
    const msg = new web3.TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new web3.VersionedTransaction(msg); tx.sign([kp]);
    const sig = await c.sendTransaction(tx, { maxRetries: 5 });
    const r = await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
    if (r.value.err) throw new Error(`TX_FAILED:${sig}`);
    return sig;
  };
}

async function readTable(c, table) {
  const t = (await c.getAddressLookupTable(new web3.PublicKey(table))).value;
  if (!t) return null;
  return { authority: t.state.authority?.toBase58() ?? null, frozen: !t.state.authority, active: t.state.deactivationSlot === 18446744073709551615n,
    lastExtendedSlot: Number(t.state.lastExtendedSlot), addresses: t.state.addresses.map((x) => x.toBase58()) };
}

async function verify(c, table, expected) {
  const t = await readTable(c, table);
  if (!t) return { ok: false, reason: "TABLE_NOT_FOUND" };
  const slot = await c.getSlot("finalized");
  const missing = expected.filter((x) => !t.addresses.includes(x));
  const problems = [
    t.authority !== DEPLOYER && "AUTHORITY_NOT_DEPLOYER", t.frozen && "FROZEN", !t.active && "DEACTIVATED",
    !(t.lastExtendedSlot < slot) && "NOT_WARMED", t.addresses.length > 256 && "TOO_MANY", missing.length && "MISSING_ENTRIES",
  ].filter(Boolean);
  return { ok: problems.length === 0, problems, missing, entries: t.addresses.length, authority: t.authority, lastExtendedSlot: t.lastExtendedSlot, finalizedSlot: slot };
}

const usage = () => { console.error("usage: alt-create.mjs static <OPS> <PLATFORM> [KEYPAIR] [RPC] [--send] | extend <TABLE> <MCP_MINT> <OPS> <PLATFORM> [KEYPAIR] [RPC] [--send] | verify <TABLE> [MCP_MINT OPS PLATFORM] [RPC]"); process.exit(2); };

try {
  if (mode === "static") {
    const [ops, plat, keyPath, rpc = PUBLIC_RPC] = a;
    if (!isKey(ops) || !isKey(plat)) usage();
    const plan = staticPlan(ops, plat, rpc);
    const c = new web3.Connection(rpc, "confirmed");
    const onChain = await checkOnMainnet(c, plan.entries.map((e) => e.address));
    const rent = await c.getMinimumBalanceForRentExemption(56 + 32 * plan.entries.length);
    const balance = await c.getBalance(new web3.PublicKey(DEPLOYER));
    const summary = { authorityAndPayer: DEPLOYER, staticEntries: plan.entries.length, programsExecutable: plan.entries.every((e, i) => !/program/.test(e.role ?? "") || onChain[i].executable), pdasWithoutAccount: onChain.filter((x) => !x.exists).map((x) => x.address), rentLamports: rent, networkFeeLamports: 10_000, deployerBalanceLamports: balance, referenceScenarios: plan.scenarios };
    if (!SEND) { out({ result: "DRY_RUN_NOTHING_SENT", ...summary, entries: plan.entries.map((e, i) => ({ ...e, ...onChain[i] })) }); process.exit(0); }
    // Event-authority PDAs often hold no account; that is normal. Program entries must be live programs.
    if (!summary.programsExecutable) { out({ result: "BLOCKED", reason: "PROGRAM_NOT_EXECUTABLE", onChain }); process.exit(1); }
    if (balance < rent + 50_000) { out({ result: "BLOCKED", reason: "INSUFFICIENT_SOL", ...summary }); process.exit(1); }
    const kp = loadAuthority(keyPath), send = await sender(c, kp);
    const recentSlot = await c.getSlot("finalized");
    const [createIx, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: kp.publicKey, payer: kp.publicKey, recentSlot });
    const extendIx = web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: kp.publicKey, payer: kp.publicKey, addresses: plan.entries.map((e) => new web3.PublicKey(e.address)) });
    const createSig = await send([createIx]);
    const extendSig = await send([extendIx]);
    await new Promise((r) => setTimeout(r, 2000));
    const v = await verify(c, table.toBase58(), plan.entries.map((e) => e.address));
    out({ result: v.ok ? "STATIC_TABLE_CREATED_AND_VERIFIED" : "CREATED_CHECK_FAILED", lookupTable: table.toBase58(), createSig, extendSig, verify: v,
      next: "Record this address. Do NOT set MCPX_LOOKUP_TABLE yet — extend it with the $MCP mint first." });
  } else if (mode === "extend") {
    const [table, mint, ops, plat, keyPath, rpc = PUBLIC_RPC] = a;
    if (![table, mint, ops, plat].every(isKey)) usage();
    const c = new web3.Connection(rpc, "confirmed");
    const plan = planFor(mint, ops, plat, rpc);
    const want = plan.entries.map((e) => e.address);
    const t = await readTable(c, table);
    if (!t) { out({ result: "BLOCKED", reason: "TABLE_NOT_FOUND" }); process.exit(1); }
    if (t.authority !== DEPLOYER) { out({ result: "BLOCKED", reason: "AUTHORITY_NOT_DEPLOYER", authority: t.authority }); process.exit(1); }
    const add = want.filter((x) => !t.addresses.includes(x));
    const summary = { lookupTable: table, parentScenario: plan.parent, existing: t.addresses.length, toAdd: add.map((x) => ({ address: x, role: plan.entries.find((e) => e.address === x)?.role })), launchTxBytesWithTable: plan.bSizeWithAlt, limit: 1232 };
    if (!SEND || add.length === 0) {
      out({ result: add.length ? "DRY_RUN_NOTHING_SENT" : "NOTHING_TO_ADD", ...summary, verify: add.length ? undefined : await verify(c, table, want) });
      process.exit(0);
    }
    if (plan.bSizeWithAlt > 1232) { out({ result: "BLOCKED", reason: "STILL_TOO_LARGE", ...summary }); process.exit(1); }
    const kp = loadAuthority(keyPath), send = await sender(c, kp);
    const extendSig = await send([web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: new web3.PublicKey(table), authority: kp.publicKey, payer: kp.publicKey, addresses: add.map((x) => new web3.PublicKey(x)) })]);
    await new Promise((r) => setTimeout(r, 2000));
    const v = await verify(c, table, want);
    out({ result: v.ok ? "EXTENDED_AND_VERIFIED" : "EXTENDED_CHECK_FAILED", extendSig, ...summary, verify: v,
      next: v.ok ? `Set MCPX_LOOKUP_TABLE=${table} and MCPX_QUOTE_MINT=${mint} on Builder #2 only.` : "Do not configure; investigate." });
  } else if (mode === "verify") {
    const [table, mint, ops, plat, rpc = PUBLIC_RPC] = a;
    if (!isKey(table)) usage();
    const c = new web3.Connection(rpc, "confirmed");
    const want = mint ? planFor(mint, ops, plat, rpc).entries.map((e) => e.address) : staticPlan(ops ?? "5MzN9A2h4w4RdYvwDXUv8ssvJiPPJa9bnamh6yMWFqh5", plat ?? "CqaJhS4BKK791cv2fSsbbc75difqCrTiwkzeeR8WqJVB", rpc).entries.map((e) => e.address);
    out({ result: "READ_ONLY", against: mint ? "full plan for $MCP" : "static plan", ...(await verify(c, table, want)) });
  } else usage();
} catch (e) {
  out({ result: "BLOCKED", reason: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
