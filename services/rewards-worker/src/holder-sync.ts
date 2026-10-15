// 05-H holder-index sync step for the DRY-RUN rewards worker. Read-only RPC; writes only mcpx_rw_hix_* tables.
// One bounded pass: mint feed since checkpoint → replay → getMultipleAccounts verification at one finalized slot →
// targeted per-account repair → persist. Any unresolved mismatch records a gap (snapshots stay blocked).
import { initIndex, applyTx } from "../../../src/lib/rewards/holder-index";
import { loadIndex, saveBatch } from "../../../src/lib/rewards/holder-index.pg";
import type { Db } from "../../../src/lib/rewards/store.pg";
import { fullHistory, signatures, verifyKnownAccounts, toIndexed, type Meter, type Rpc } from "./helius-history";

export async function syncHolders(db: Db, rpc: Rpc, meter: Meter, mint: string, genesisAnchorSlot: number | null) {
  let s = await loadIndex(db, mint);
  if (!s) { if (genesisAnchorSlot === null) return { kind: "BLOCKED" as const, reason: "ANCHOR_SLOT_UNSET" }; s = initIndex(mint, { slot: genesisAnchorSlot, verified: true, accounts: [] }); }
  const known = [...s.balances.keys()];
  const v = known.length ? await verifyKnownAccounts(rpc, known) : { slot: (await rpc("getSlot", [{ commitment: "finalized" }])) as number, accounts: new Map() };
  if (!v) return { kind: "RETRY" as const, reason: "NO_CONSISTENT_SLOT" };
  const from = s.coveredTo;
  const txs = (await fullHistory(rpc, meter, mint, mint, v.slot, from)).sort((a, b) => a.slot - b.slot || a.txIndex - b.txIndex);
  const applied: typeof txs = []; const touched = new Set<string>();
  const apply = (t: (typeof txs)[number]) => { const r = applyTx(s!, t); if (typeof r === "object") return r.error; if (r !== "DUPLICATE") { applied.push(t); for (const b of [...t.pre, ...t.post]) touched.add(b.account); } return null; };
  let err: string | null = null;
  for (const t of txs) { err = apply(t); if (err) break; }
  const diff = () => known.filter((k) => { const a = v.accounts.get(k), b = s!.balances.get(k); return a === null ? !!b && b.amount !== 0n : !b || a.amount !== b.amount || a.owner !== b.owner; });
  if (!err) for (const k of diff()) {
    const extra = (await signatures(rpc, meter, k, v.slot)).filter((x) => x.slot > from && !s!.applied.has(x.signature));
    const got = [];
    for (const x of extra) { const t = await rpc("getTransaction", [x.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]); if (t) got.push(toIndexed({ ...t, transactionIndex: x.txIndex }, mint)); }
    // targeted txs must be merged in chain order with the window; simplest safe path: rebuild window from scratch next pass
    if (got.length) { err = "NON_MINT_TRANSITIONS_FOUND_REBUILD_WINDOW"; break; }
  }
  const remaining = err ? null : diff();
  if (err || (remaining && remaining.length)) {
    s.gaps.push({ fromSlot: from + 1, toSlot: v.slot, reason: err ?? "ACCOUNT_VERIFY_MISMATCH" });
    await saveBatch(db, s, "helius", [], new Set());
    return { kind: "GAP" as const, reason: err ?? "ACCOUNT_VERIFY_MISMATCH", fromSlot: from + 1, toSlot: v.slot };
  }
  s.coveredTo = v.slot;
  await saveBatch(db, s, "helius:gTFA+gMA", applied, touched);
  return { kind: "SYNCED" as const, toSlot: v.slot, newTxs: applied.length, accounts: s.balances.size };
}
