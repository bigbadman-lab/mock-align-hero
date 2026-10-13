// READ-ONLY 05-H probe: reconstruct a real Token-2022 coin's full holder history from Helius and reconcile it
// against getProgramAccounts + getTokenSupply at the same finalized slot. Never signs or sends. Key read from env only.
import { writeFileSync } from "node:fs";
import { initIndex, applyTx, recordCoverage, repairGap, snapshotAt, type IndexState, type IndexedTx } from "../../../src/lib/rewards/holder-index";
import { heliusRpc, fullHistory, signatures, stateAtSameSlot, credits, type Meter } from "../src/helius-history";

const KEY = process.env.MCPX_HELIUS_TEST_API_KEY; if (!KEY) throw new Error("key unset");
const MINT = process.argv[2] ?? "8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const meter: Meter = {}; const rpc = heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, meter);
const out: Record<string, unknown> = { mint: MINT }; const t0 = Date.now();
type Tx = IndexedTx & { txIndex: number };
const order = (a: Tx, b: Tx) => a.slot - b.slot || a.txIndex - b.txIndex;

function replay(txs: Tx[], anchorSlot: number, s?: IndexState) {
  const st = s ?? initIndex(MINT, { slot: anchorSlot, verified: true, accounts: [] });
  for (const t of txs) { const r = applyTx(st, t); if (typeof r === "object") return { st, error: r.error, at: t.signature, slot: t.slot }; }
  return { st, error: null as string | null };
}
const pool = async <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) => { const res: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; res[k] = await f(xs[k]!); } })); return res; };

const state = await stateAtSameSlot(rpc, MINT, T22);
if (!state) { console.log(JSON.stringify({ verdict: "BLOCKED", reason: "NO_CONSISTENT_FINALIZED_POSITION" })); process.exit(0); }
const C = state.slot; out.finalizedSlot = C; out.supply = String(state.supply); out.liveAccounts = state.accounts.size;

const mintTxs = (await fullHistory(rpc, meter, MINT, MINT, C)).sort(order);
const anchor = mintTxs[0]!.slot - 1; // mint did not exist before its first transaction → empty, verified anchor
out.mintHistory = { txs: mintTxs.length, firstSlot: mintTxs[0]!.slot, firstHasEmptyPre: mintTxs[0]!.pre.length === 0 };
const a = replay(mintTxs, anchor); out.mintOnlyReplay = a.error ? { error: a.error, slot: a.slot } : "CLEAN";

// discover every token account that ever existed; then per-account history for transitions not referencing the mint
const accounts = new Set<string>(); for (const t of mintTxs) for (const b of [...t.pre, ...t.post]) accounts.add(b.account);
for (const k of state.accounts.keys()) if (!accounts.has(k)) (out.liveAccountsNotDiscovered ??= [] as string[]) && (out.liveAccountsNotDiscovered as string[]).push(k);
out.accountsEverSeen = accounts.size; out.closedAccounts = [...accounts].filter((k) => !state.accounts.has(k)).length;
const known = new Set(mintTxs.map((t) => t.signature));
const sigLists = await pool([...accounts], 10, (acc) => signatures(rpc, meter, acc, C));
const extraSigs = [...new Set(sigLists.flat().filter((s) => !known.has(s.signature)).map((s) => s.signature))];
out.extraTxsNotReferencingMint = extraSigs.length;
const extras = (await pool(extraSigs, 10, async (sig) => {
  const t = await rpc("getTransaction", [sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 1 }]);
  return t ? { ...(await import("../src/helius-history")).toIndexed({ ...t, transactionIndex: sigLists.flat().find((s) => s.signature === sig)!.txIndex }, MINT) } : null;
}))).filter(Boolean) as Tx[];
const all = [...mintTxs, ...extras].sort(order);
const b = replay(all, anchor); out.fullReplay = b.error ? { error: b.error, slot: b.slot } : "CLEAN";

// reconcile at C
recordCoverage(b.st, { fromSlot: anchor + 1, toSlot: C, complete: !b.error, source: "helius:gTFA(mint)+gTFA(each account)" });
const mism: string[] = [];
for (const [k, v] of state.accounts) { const m = b.st.balances.get(k); if (!m || m.amount !== v.amount || m.owner !== v.owner) mism.push(k); }
for (const [k, v] of b.st.balances) if (!state.accounts.has(k) && v.amount !== 0n) mism.push(k);
out.accountMismatches = mism.length;
const snap = snapshotAt(b.st, C, state.supply);
out.snapshot = snap.kind === "SNAPSHOT" ? { holders: snap.owners.length, total: String(snap.total), supplyMatches: snap.total === state.supply } : snap;

// restart recovery: stop halfway, persist checkpoint as JSON, resume in a fresh state object
const half = Math.floor(all.length / 2);
const p1 = replay(all.slice(0, half), anchor);
const ckpt = JSON.stringify({ anchorSlot: p1.st.anchorSlot, balances: [...p1.st.balances].map(([k, v]) => [k, v.owner, String(v.amount)]), applied: [...p1.st.applied] });
const j = JSON.parse(ckpt);
const resumed: IndexState = { mint: MINT, anchorSlot: j.anchorSlot, balances: new Map(j.balances.map(([k, o, a]: string[]) => [k, { owner: o, amount: BigInt(a) }])), applied: new Set(j.applied), coveredTo: anchor, gaps: [] };
const p2 = replay(all, anchor, resumed); // overlap replay of first half must be all DUPLICATE
const same = !p2.error && [...b.st.balances].every(([k, v]) => resumed.balances.get(k)?.amount === v.amount);
out.restartRecovery = { checkpointAtTx: half, overlapReplayed: half, identical: same };

// gap detection + backfill: drop a middle slot range, observe the failure, repair with a complete replay of that range
const mid = all[Math.floor(all.length * 0.6)]!.slot; const gapTxs = all.filter((t) => t.slot >= mid && t.slot <= mid + 2);
const g = replay(all.filter((t) => !gapTxs.includes(t)), anchor);
const gs = g.st; recordCoverage(gs, { fromSlot: anchor + 1, toSlot: C, complete: false, source: "simulated-drop" });
const blockedWhileGap = snapshotAt(gs, C, state.supply);
const fresh = replay(all, anchor); const repaired = repairGap(fresh.st, { fromSlot: anchor + 1, toSlot: C }, { fromSlot: anchor + 1, toSlot: C, complete: !fresh.error, source: "helius-backfill" });
recordCoverage(fresh.st, { fromSlot: anchor + 1, toSlot: C, complete: true, source: "helius-backfill" });
out.gap = { droppedTxs: gapTxs.length, detectedBy: g.error ?? "SNAPSHOT_BLOCKED", snapshotWhileGap: blockedWhileGap.kind === "BLOCKED" ? blockedWhileGap.reason : "UNEXPECTED_SNAPSHOT",
  repairedByReplay: repaired || fresh.st.gaps.length === 0, snapshotAfterRepair: snapshotAt(fresh.st, C, state.supply).kind };

out.meter = meter; out.estCredits = { archival10: credits(meter, 10), archival1: credits(meter, 1) }; out.seconds = Math.round((Date.now() - t0) / 1000);
const ser = JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
writeFileSync(process.env.OUT ?? "/tmp/h/probe.json", ser);
writeFileSync("/tmp/h/state.json", JSON.stringify({ C, anchor, txs: all.map((t) => ({ ...t, pre: t.pre.map((x) => ({ ...x, amount: String(x.amount) })), post: t.post.map((x) => ({ ...x, amount: String(x.amount) })) })) }));
console.log(ser);
