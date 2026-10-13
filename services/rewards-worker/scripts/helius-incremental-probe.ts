// READ-ONLY 05-H: resume from the probe's persisted state, ingest one incremental window (mint feed only),
// then verify every known account with getMultipleAccounts at a single finalized slot. Measures credits.
import { readFileSync, writeFileSync } from "node:fs";
import { initIndex, applyTx } from "../../../src/lib/rewards/holder-index";
import { heliusRpc, fullHistory, signatures, verifyKnownAccounts, toIndexed, type Meter } from "../src/helius-history";
const KEY = process.env.MCPX_HELIUS_TEST_API_KEY!; const MINT = "8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump";
const meter: Meter = {}; const rpc = heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, meter);
const st0 = JSON.parse(readFileSync("/tmp/h/state.json", "utf8"));
const rev = (t: any) => ({ ...t, pre: t.pre.map((x: any) => ({ ...x, amount: BigInt(x.amount) })), post: t.post.map((x: any) => ({ ...x, amount: BigInt(x.amount) })) });
const s = initIndex(MINT, { slot: st0.anchor, verified: true, accounts: [] });
for (const t of st0.txs) applyTx(s, rev(t));
const known = [...s.balances.keys()];
let v = null; for (let i = 0; i < 5 && !v; i++) v = await verifyKnownAccounts(rpc, known);
if (!v) throw new Error("no consistent slot");
const C2 = v.slot;
const inc = (await fullHistory(rpc, meter, MINT, MINT, C2)).filter((t) => t.slot > st0.C).sort((a, b) => a.slot - b.slot || a.txIndex - b.txIndex);
let err: string | null = null; for (const t of inc) { const r = applyTx(s, t); if (typeof r === "object") { err = r.error; break; } }
const diffs = known.filter((k) => { const a = v!.accounts.get(k), b = s.balances.get(k); return a === null ? (b !== undefined && b.amount !== 0n) : !b || a!.amount !== b.amount || a!.owner !== b.owner; });
// targeted repair: per-account history only for the accounts that differ
let repaired = 0;
for (const k of diffs) {
  const sigs = (await signatures(rpc, meter, k, C2)).filter((x) => x.slot > st0.C && !s.applied.has(x.signature));
  for (const x of sigs) { const t = await rpc("getTransaction", [x.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 1 }]); if (t) { applyTx(s, toIndexed({ ...t, transactionIndex: x.txIndex }, MINT)); repaired++; } }
}
const after = known.filter((k) => { const a = v!.accounts.get(k), b = s.balances.get(k); return a === null ? (b !== undefined && b.amount !== 0n) : !b || a!.amount !== b.amount || a!.owner !== b.owner; });
const out = { fromSlot: st0.C, toSlot: C2, newMintTxs: inc.length, replayError: err, knownAccounts: known.length, diffsAfterMintFeed: diffs.length, targetedTxsFetched: repaired, diffsAfterRepair: after.length, meter,
  note: "full-history probe re-queried; a production worker only fetches slot > checkpoint (fullHistory here re-reads from creation)" };
writeFileSync("/tmp/h/incremental.json", JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2));
