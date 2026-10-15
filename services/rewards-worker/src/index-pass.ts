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
  const ck = (await db.query("select covered_to_slot from public.mcpx_rw_hix_checkpoints where mint=$1", [o.mint])).rows[0];
  for (const w of todo) {
    // 05-I.1: seed from the latest validated FROZEN cutoff before w (a search hint only, never proof)
    const hr = (await db.query("select extract(epoch from window_start)::bigint w, cutoff_slot from public.mcpx_rw_hix_frozen_snapshots where mint=$1 and window_start < $2 order by window_start desc limit 1", [o.mint, new Date(w * 1000).toISOString()])).rows[0];
    const r = await selectCutoff(w, o.deps, { hint: hr ? { windowStart: Number(hr.w), cutoffSlot: Number(hr.cutoff_slot) } : null }); const saved = await saveCutoff(db, o.mint, w, r);
    out.push({ window: w, result: `${saved}${r.kind === "HOLD" ? ":" + r.reason : ""}` });
    // index already past this cutoff without a capture → only a controlled rebuild can produce this window
    if (r.kind === "SELECTED" && saved === "SELECTED" && ck && Number(ck.covered_to_slot) >= r.evidence.cutoffSlot)
      await db.query("insert into public.mcpx_rw_hix_holds (mint, window_start, reason) values ($1,$2,'CUTOFF_BEHIND_CHECKPOINT_REBUILD_REQUIRED') on conflict do nothing", [o.mint, new Date(w * 1000).toISOString()]);
    if (r.kind === "HOLD") break;
  }
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
  // never advance the index past the end of a window whose cutoff is not selected yet (it could not be captured later)
  const lastSel = (await db.query("select extract(epoch from max(window_start))::bigint w from public.mcpx_rw_hix_window_cutoffs where mint=$1 and status='SELECTED'", [o.mint])).rows[0]?.w;
  const nextEnd = (lastSel === null || lastSel === undefined ? o.genesisWindow : Number(lastSel) + 300) + 300;
  const vt = await o.deps.blockTime(V);
  if (vt === undefined || vt === null) return { kind: "RETRY" as const, reason: "HEAD_TIME_UNKNOWN" };
  if (vt >= nextEnd) return { kind: "RETRY" as const, reason: "AWAITING_CUTOFF_SELECTION", nextWindowEnd: nextEnd };
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
  // FIX-HIX-02: the chain is read ONCE per pass (slot v.slot). If it moved past V, the mint history is extended to
  // v.slot and the replay is compared against that SAME read — re-reading would move the chain again on a busy token
  // and never converge. Non-convergence or an unexplained mismatch writes nothing (RETRY next pass); it never records
  // a permanent gap/hold, because nothing was committed and the next pass replays the same range from the checkpoint.
  let verified: Set<string> | null = null;
  for (let round = 0; ; round++) {
    if (round >= (o.maxRounds ?? 8)) return { kind: "RETRY" as const, reason: "NOT_CONVERGED" };
    s = cloneIndex(s0);
    const txs = [...byKey.values()].filter((t) => t.slot <= V);
    rep = replayCapturing(s, txs, cutoffsAll.filter((c) => c.cutoffSlot <= V).map((c) => c.cutoffSlot));
    if ("error" in rep) {
      const m = /PRE_BALANCE_MISMATCH:(.+)$/.exec(String(rep.error));
      if (m && !swept.has(m[1]!)) { await sweep([m[1]!]); continue; }
      if (m) return { kind: "RETRY" as const, reason: "PRE_BALANCE_MISMATCH" };
      return gap(String(rep.error), V);
    }
    // (5) verify every known/touched account + the mint at ONE finalized slot ≥ V (once per pass)
    if (!v) {
      const check = [...new Set([...known, ...accountsIn(txs)])];
      v = await verifyKnownAccounts(rpc, [...check, o.mint]);
      if (!v) return { kind: "RETRY" as const, reason: "NO_CONSISTENT_SLOT" };
      mintNow = v.accounts.get(o.mint); v.accounts.delete(o.mint); verified = new Set(check);
      if (v.slot > V) { // chain moved: pull (V, v.slot] for the mint and replay up to v.slot against this same read
        const more = await fullHistory(rpc, meter, o.mint, o.mint, v.slot, V); V = v.slot;
        swept.clear(); // per-account sweeps must be redone up to the new V
        if (more.length) { for (const t of more) add(t); continue; }
      }
    }
    // Accounts first seen in (old V, v.slot] were not part of the read; their replay is still pre-balance checked.
    const bad = [...verified!].filter((k) => { const a = v!.accounts.get(k), b = s.balances.get(k); return a === null || a === undefined ? !!b && b.amount !== 0n : !b || a.amount !== b.amount || a.owner !== b.owner; });
    if (!bad.length) break;
    if (!(await sweep(bad))) return { kind: "RETRY" as const, reason: "ACCOUNT_VERIFY_MISMATCH" };
  }
  if (!v || !rep || "error" in rep) return gap("INTERNAL", V);
  const txs = [...byKey.values()].filter((t) => t.slot <= V);
  const cutoffs = cutoffsAll.filter((c) => c.cutoffSlot <= V);
  s.coveredTo = v.slot;
  // FIX-HIX-02 self-heal: this pass replayed complete, verified history for (from, v.slot]. Any open gap lying wholly
  // inside that range is now covered; it is marked repaired (and its HOLDER_HISTORY_GAP holds resolved) in the SAME
  // transaction that freezes snapshots. Gaps reaching back before `from` stay open (fail closed).
  const repairedGaps = s.gaps.filter((g) => g.fromSlot > from && g.toSlot <= v!.slot);
  s.gaps = s.gaps.filter((g) => !repairedGaps.includes(g));
  const healAll = repairedGaps.length > 0 && s.gaps.length === 0;
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
