// Phase 05-I.1 — complete from-anchor history for an operator recovery candidate. READ-ONLY RPC.
// mint history to exhaustion ≤ V + per-account history for every account ever seen (once), then one-slot verification
// at V. If the chain moved, V is extended with the mint feed and ONLY accounts whose replayed state disagrees with the
// chain are re-swept up to the new V (bounded rounds). `complete` = replay equals chain at V for every account.
import { fullHistory, signatures, verifyKnownAccounts, toIndexed, type Meter, type Rpc } from "./helius-history";
import { initIndex } from "../../../src/lib/rewards/holder-index";
import { replayCapturing } from "../../../src/lib/rewards/cutoff-snapshot";
import type { RecoveryTx } from "../../../src/lib/rewards/recovery";

const pool = async <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) => { const res: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; res[k] = await f(xs[k]!); } })); return res; };

export async function gatherHistory(rpc: Rpc, meter: Meter, mint: string, anchorSlot: number, maxRounds = 6) {
  let V = (await rpc("getSlot", [{ commitment: "finalized" }])) as number;
  const by = new Map<string, RecoveryTx>(); const sweptAt = new Map<string, number>();
  for (const t of await fullHistory(rpc, meter, mint, mint, V, anchorSlot)) by.set(t.signature, t);
  const sweep = async (accts: string[]) => {
    const todo = accts.filter((a) => (sweptAt.get(a) ?? -1) < V); todo.forEach((a) => sweptAt.set(a, V));
    const lists = await pool(todo, 8, (a) => signatures(rpc, meter, a, V));
    const missing = [...new Map(lists.flat().filter((x) => x.slot > anchorSlot && !by.has(x.signature)).map((x) => [x.signature, x])).values()];
    const got = await pool(missing, 8, async (x) => { const t = await rpc("getTransaction", [x.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]); return t ? toIndexed({ ...t, transactionIndex: x.txIndex }, mint) : null; });
    for (const t of got) if (t) by.set(t.signature, t);
  };
  const accounts = () => { const x = new Set<string>(); for (const t of by.values()) for (const b of [...t.pre, ...t.post]) x.add(b.account); return [...x]; };
  const fail = (reason: string) => ({ anchorSlot, V, txs: [...by.values()], complete: false, reason, chainAtV: new Map<string, { owner: string; amount: bigint } | null>(), mintSupplyAtV: null as bigint | null, accounts: accounts().length });
  await sweep(accounts());
  for (let round = 0; round < maxRounds; round++) {
    const all = accounts();
    const v = await verifyKnownAccounts(rpc, [...all, mint]);
    if (!v) continue;
    const mintAcc = v.accounts.get(mint); v.accounts.delete(mint);
    if (v.slot > V) { for (const t of await fullHistory(rpc, meter, mint, mint, v.slot, V)) by.set(t.signature, t); V = v.slot; }
    const txs = [...by.values()].filter((t) => t.slot <= V);
    const s = initIndex(mint, { slot: anchorSlot, verified: true, accounts: [] });
    const rep = replayCapturing(s, txs, []);
    let bad: string[];
    if ("error" in rep) { const m = /PRE_BALANCE_MISMATCH:(.+)$/.exec(String(rep.error)); if (!m) return fail(String(rep.error)); bad = [m[1]!]; }
    else bad = accounts().filter((k) => { const a = v.accounts.get(k), b = s.balances.get(k); return a === null || a === undefined ? !!b && b.amount !== 0n : !b || a.amount !== b.amount || a.owner !== b.owner; });
    if (!bad.length && !("error" in rep) && accounts().every((k) => v.accounts.has(k)))
      return { anchorSlot, V, txs, complete: true, reason: null, chainAtV: v.accounts as Map<string, { owner: string; amount: bigint } | null>, mintSupplyAtV: mintAcc ? mintAcc.amount : null, accounts: all.length };
    await sweep(bad.length ? bad : accounts().filter((k) => !v.accounts.has(k)));
  }
  return fail("NOT_CONVERGED_WITHIN_ROUNDS");
}
