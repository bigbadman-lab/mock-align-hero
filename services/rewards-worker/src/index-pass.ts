// Phase 05-I — one bounded holder-index pass with window-cutoff snapshot freezing. READ-ONLY chain access.
// Order: (1) select & persist finalized cutoffs for ended windows, (2) read every known account + the mint at ONE
// finalized slot V, (3) fetch the mint's complete history in (checkpoint, V], (4) replay in (slot, txIndex) order,
// capturing state at each pending cutoff, (5) verify replay == chain at V (else GAP + nothing frozen),
// (6) prove supply at each cutoff from mint-at-V minus instruction deltas, (7) freeze + advance checkpoint in ONE
// transaction guarded by compare-and-swap. Late-processed windows reuse their stored cutoff, never "now".
import { initIndex } from "../../../src/lib/rewards/holder-index";
import { loadIndex } from "../../../src/lib/rewards/holder-index.pg";
import { selectCutoff, FINALITY_GUARD_SECONDS, type CutoffDeps } from "../../../src/lib/rewards/cutoff";
import { replayCapturing, cloneIndex, freezeSnapshot, type OwnerKind } from "../../../src/lib/rewards/cutoff-snapshot";
import { supplyAtCutoff, type SupplyProof } from "../../../src/lib/rewards/supply-proof";
import { policyFor } from "../../../src/lib/rewards/eligibility-policy";
import { saveCutoff, loadSelectedCutoffs, commitPass, openHoldWindows, loadPolicies, type PassWrite } from "../../../src/lib/rewards/cutoff-snapshot.pg";
import type { Db } from "../../../src/lib/rewards/store.pg";
import { fullHistory, signatures, verifyKnownAccounts, toIndexed, type Meter, type Rpc } from "./helius-history";

export type PassOpts = { mint: string; anchorSlot: number | null; genesisWindow: number; maxCutoffsPerPass: number; ownerKind: OwnerKind; deps: CutoffDeps; nowSec: number };

export async function selectPendingCutoffs(db: Db, o: PassOpts) {
  const last = (await db.query("select extract(epoch from max(window_start))::bigint w from public.mcpx_rw_hix_window_cutoffs where mint=$1 and status='SELECTED'", [o.mint])).rows[0]?.w;
  const held = (await db.query("select extract(epoch from window_start)::bigint w from public.mcpx_rw_hix_window_cutoffs where mint=$1 and status='ON_HOLD' order by 1", [o.mint])).rows.map((r) => Number(r.w));
  const next = last === null || last === undefined ? o.genesisWindow : Number(last) + 300;
  const todo = [...new Set([...held, ...Array.from({ length: o.maxCutoffsPerPass }, (_, i) => next + 300 * i)])].sort((a, b) => a - b).slice(0, o.maxCutoffsPerPass)
    .filter((w) => w + 300 + FINALITY_GUARD_SECONDS <= o.nowSec);
  const out: { window: number; result: string }[] = [];
  for (const w of todo) { const r = await selectCutoff(w, o.deps); out.push({ window: w, result: `${await saveCutoff(db, o.mint, w, r)}${r.kind === "HOLD" ? ":" + r.reason : ""}` }); if (r.kind === "HOLD") break; }
  return out;
}

type Tx = Awaited<ReturnType<typeof fullHistory>>[number];
const pool = async <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) => { const res: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; res[k] = await f(xs[k]!); } })); return res; };

export async function indexPass(db: Db, rpc: Rpc, meter: Meter, o: PassOpts & { maxRounds?: number }) {
  let s0 = await loadIndex(db, o.mint);
  if (!s0) { if (o.anchorSlot === null) return { kind: "BLOCKED" as const, reason: "ANCHOR_SLOT_UNSET" }; s0 = initIndex(o.mint, { slot: o.anchorSlot, verified: true, accounts: [] }); }
  const from = s0.coveredTo, known = [...s0.balances.keys()];
  const cutoffsAll = await loadSelectedCutoffs(db, o.mint, from);
  // (2)+(3): fixed upper slot V from a consistent finalized read; history is fetched up to V only
  let V = (await rpc("getSlot", [{ commitment: "finalized" }])) as number;
  const byKey = new Map<string, Tx>(); const add = (t: Tx) => byKey.set(t.signature, t);
  for (const t of await fullHistory(rpc, meter, o.mint, o.mint, V, from)) add(t); // paginates to exhaustion or throws
  const swept = new Set<string>();
  const sweep = async (accts: string[]) => { // per-account history: transitions that never reference the mint
    const todo = accts.filter((a) => !swept.has(a)); todo.forEach((a) => swept.add(a));
    const lists = await pool(todo, 8, (a) => signatures(rpc, meter, a, V));
    const missing = [...new Map(lists.flat().filter((x) => x.slot > from && !byKey.has(x.signature) && !s0!.applied.has(x.signature)).map((x) => [x.signature, x])).values()];
    const got = await pool(missing, 8, async (x) => { const t = await rpc("getTransaction", [x.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 1 }]); return t ? toIndexed({ ...t, transactionIndex: x.txIndex }, o.mint) : null; });
    let n = 0; for (const t of got) if (t) { add(t); n++; } return n;
  };
  const accountsIn = (txs: Iterable<Tx>) => { const x = new Set<string>(); for (const t of txs) for (const b of [...t.pre, ...t.post]) x.add(b.account); return x; };
  const gap = async (reason: string, toSlot: number) => {
    const st = s0!; st.gaps.push({ fromSlot: from + 1, toSlot, reason });
    const w: PassWrite = { state: st, expectedCoveredTo: from, source: "helius", txs: [], touched: new Set(), frozen: [], holds: cutoffsAll.map((c) => ({ windowStart: c.windowStart, reason: "HOLDER_HISTORY_GAP", detail: { reason } })) };
    return { kind: "GAP" as const, reason, commit: await commitPass(db, w), fromSlot: from + 1, toSlot };
  };
  if (from === s0.anchorSlot) await sweep([...accountsIn(byKey.values())]); // from-scratch rebuild: sweep every discovered account
  let s = s0, rep: ReturnType<typeof replayCapturing> | null = null, v: Awaited<ReturnType<typeof verifyKnownAccounts>> = null, mintNow: { amount: bigint } | null | undefined;
  for (let round = 0; ; round++) {
    if (round >= (o.maxRounds ?? 4)) return gap("UNRESOLVED_AFTER_MAX_ROUNDS", V);
    s = cloneIndex(s0);
    const txs = [...byKey.values()].filter((t) => t.slot <= V);
    rep = replayCapturing(s, txs, cutoffsAll.filter((c) => c.cutoffSlot <= V).map((c) => c.cutoffSlot));
    if ("error" in rep) {
      const m = /PRE_BALANCE_MISMATCH:(.+)$/.exec(String(rep.error));
      if (m && !swept.has(m[1]!)) { await sweep([m[1]!]); continue; }
      return gap(String(rep.error), V);
    }
    // (5) verify every known/touched account + the mint at ONE finalized slot ≥ V
    const check = [...new Set([...known, ...accountsIn(txs)])];
    v = await verifyKnownAccounts(rpc, [...check, o.mint]);
    if (!v) return { kind: "RETRY" as const, reason: "NO_CONSISTENT_SLOT" };
    mintNow = v.accounts.get(o.mint); v.accounts.delete(o.mint);
    if (v.slot > V) { // chain moved: pull (V, v.slot] for the mint and replay again at the new V
      const more = await fullHistory(rpc, meter, o.mint, o.mint, v.slot, V); V = v.slot;
      if (more.length) { for (const t of more) add(t); continue; }
    }
    const bad = check.filter((k) => { const a = v!.accounts.get(k), b = s.balances.get(k); return a === null || a === undefined ? !!b && b.amount !== 0n : !b || a.amount !== b.amount || a.owner !== b.owner; });
    if (!bad.length) break;
    if (!(await sweep(bad))) return gap("ACCOUNT_VERIFY_MISMATCH", V);
  }
  if (!v || !rep || "error" in rep) return gap("INTERNAL", V);
  const txs = [...byKey.values()].filter((t) => t.slot <= V);
  const cutoffs = cutoffsAll.filter((c) => c.cutoffSlot <= V);
  s.coveredTo = v.slot;
  const policies = await loadPolicies(db), held = await openHoldWindows(db, o.mint);
  const anchor = mintNow ? { slot: v.slot, supply: mintNow.amount } : null;
  const frozen: PassWrite["frozen"] = [], holds: PassWrite["holds"] = [];
  for (const c of cutoffs) {
    const st = rep.captured.get(c.cutoffSlot) ?? cloneIndex(s);
    const later = txs.filter((t) => t.slot > c.cutoffSlot);
    let supply: SupplyProof;
    const unknown = later.find((t) => typeof t.supplyDelta !== "bigint");
    if (unknown) supply = { kind: "UNPROVEN", reason: `UNKNOWN_SUPPLY_IX:${(unknown.supplyDelta as { unknown: string }).unknown}` };
    else { const net = later.reduce((x, t) => x + (t.supplyDelta as bigint), 0n); supply = anchor ? supplyAtCutoffFromNet(c.cutoffSlot, anchor, net, later.length) : supplyAtCutoff(c.cutoffSlot, null, [], o.mint, true); }
    const f = await freezeSnapshot({ state: st, cutoff: c, supply, checkpointSlot: v.slot, gaps: s.gaps, policy: policyFor(c.windowStart, policies), ownerKind: o.ownerKind, heldWindows: held });
    if (f.kind === "FROZEN") frozen.push({ snap: f.snap, supply }); else holds.push({ windowStart: c.windowStart, reason: f.reason });
  }
  const touched = accountsIn(txs);
  const commit = await commitPass(db, { state: s, expectedCoveredTo: from, source: "helius:gTFA+gMA", txs, touched, frozen, holds });
  return { kind: commit === "COMMITTED" ? ("SYNCED" as const) : ("STALE" as const), toSlot: v.slot, newTxs: txs.length, accounts: s.balances.size,
    frozen: frozen.map((f) => ({ window: f.snap.windowStart, cutoff: f.snap.cutoffSlot, owners: f.snap.owners.length, digest: f.snap.digest.slice(0, 16) })), holds };
}

function supplyAtCutoffFromNet(cutoffSlot: number, anchor: { slot: number; supply: bigint }, net: bigint, n: number): SupplyProof {
  const v = anchor.supply - net;
  if (v < 0n) return { kind: "UNPROVEN", reason: "NEGATIVE_SUPPLY" };
  return { kind: "PROVEN", cutoffSlot, supplyAtCutoff: v, anchorSlot: anchor.slot, anchorSupply: anchor.supply, laterTxs: n, laterNetChange: net, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" };
}
