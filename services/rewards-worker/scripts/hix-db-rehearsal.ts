// Throwaway local Postgres rehearsal with REAL Helius-derived data (/tmp/h/state.json). Never touches production.
// Two OS processes: process A persists the first part then is killed; process B reloads, replays overlap, finishes.
import { readFileSync } from "node:fs";
import { initIndex, applyTx, recordCoverage, snapshotAt } from "../../../src/lib/rewards/holder-index";
import { loadIndex, saveBatch, saveSnapshot } from "../../../src/lib/rewards/holder-index.pg";
// @ts-ignore throwaway embedded Postgres outside the project
const { PGlite } = await import("/tmp/pgl/node_modules/@electric-sql/pglite/dist/index.js");
const pg = new PGlite(process.env.PGDIR ?? "/tmp/hpg/data");
const db = { query: async (t: string, p?: unknown[]) => ({ rows: (await pg.query(t, p ?? [])).rows as any[] }) };
if (process.argv[2] === "INIT") { await pg.exec("create role anon; create role authenticated; create role service_role;"); await pg.exec(readFileSync("/dev-server/drizzle/migrations/0009_mcpx_05g_holder_index.sql", "utf8").replace(/--> statement-breakpoint/g, "")); console.log("init ok"); process.exit(0); }
const MINT = "8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump";
const st = JSON.parse(readFileSync("/tmp/h/state.json", "utf8"));
const txs = st.txs.map((t: any) => ({ ...t, pre: t.pre.map((x: any) => ({ ...x, amount: BigInt(x.amount) })), post: t.post.map((x: any) => ({ ...x, amount: BigInt(x.amount) })) }));
const role = process.argv[2]; const stopAt = Number(process.argv[3] ?? txs.length);
let s = (await loadIndex(db, MINT)) ?? initIndex(MINT, { slot: st.anchor, verified: true, accounts: [] });
const resumedApplied = s.applied.size;
let batch: any[] = [], touched = new Set<string>(), dup = 0;
for (let i = 0; i < Math.min(stopAt, txs.length); i++) {
  const t = txs[i]; const r = applyTx(s, t);
  if (r === "DUPLICATE") { dup++; continue; }
  if (typeof r === "object") throw new Error(r.error);
  batch.push(t); for (const b of [...t.pre, ...t.post]) touched.add(b.account);
  if (batch.length === 500) { await saveBatch(db, s, "helius", batch, touched); batch = []; touched = new Set(); }
}
if (batch.length) await saveBatch(db, s, "helius", batch, touched);
if (role === "A") { console.log(JSON.stringify({ role, applied: s.applied.size })); process.kill(process.pid, "SIGKILL"); }
recordCoverage(s, { fromSlot: st.anchor + 1, toSlot: st.C, complete: true, source: "helius" });
await saveBatch(db, s, "helius", [], new Set());
const re = await loadIndex(db, MINT);
const snap = snapshotAt(re!, st.C, 999999999999999n);
const sum = (await db.query("select sum(amount)::text s, count(*) n from public.mcpx_rw_hix_balances where mint=$1", [MINT])).rows[0];
const applied = (await db.query("select count(*) n from public.mcpx_rw_hix_applied_txs where mint=$1", [MINT])).rows[0];
let snapRes: string | null = null;
if (snap.kind === "SNAPSHOT") { const d = JSON.stringify(snap.owners.map((o) => [o.owner, String(o.amount)])); snapRes = await saveSnapshot(db, MINT, 1791882000, st.C, snap.total, snap.owners.length, String(d.length) + ":" + d.slice(0, 64)); }
console.log(JSON.stringify({ role, resumedApplied, duplicatesSkipped: dup, dbAppliedRows: applied.n, dbBalanceSum: sum.s, dbAccounts: sum.n, snapshot: snap.kind === "SNAPSHOT" ? snap.owners.length : snap, snapshotWrite: snapRes,
  snapshotReplay: snap.kind === "SNAPSHOT" ? await saveSnapshot(db, MINT, 1791882000, st.C, snap.total, snap.owners.length, String(JSON.stringify(snap.owners.map((o) => [o.owner, String(o.amount)])).length) + ":" + JSON.stringify(snap.owners.map((o) => [o.owner, String(o.amount)])).slice(0, 64)) : null }));
await pg.close();
