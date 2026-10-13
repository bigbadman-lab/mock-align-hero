// Phase 05-I rehearsal: REAL Helius read-only data → THROWAWAY local Postgres (MCPX_TEST_PG_URL). Never production.
// Modes: INIT | CUTOFFS | PASS [DIE=1 kills inside the commit] | REPORT | LATEHOLD
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { heliusRpc, cutoffDeps, credits, type Meter } from "../src/helius-history";
import { indexPass, selectPendingCutoffs } from "../src/index-pass";
import { savePolicy, commitPass } from "../../../src/lib/rewards/cutoff-snapshot.pg";
import { POLICY_V1_DRAFT, type EligibilityPolicy } from "../../../src/lib/rewards/eligibility-policy";
import { loadIndex } from "../../../src/lib/rewards/holder-index.pg";

const URL_ = process.env.MCPX_TEST_PG_URL!; if (!/127\.0\.0\.1|localhost/.test(URL_)) throw new Error("throwaway local DB only");
const KEY = process.env.MCPX_HELIUS_TEST_API_KEY; if (!KEY) throw new Error("key unset");
const MINT = "8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump", ANCHOR = 456380696;
const sql = postgres(URL_, { max: 1, onnotice: () => {} });
let dieArmed = process.env.DIE === "1";
const db = { query: async (t: string, p?: unknown[]) => {
  const rows = (await sql.unsafe(t, (p ?? []) as never[])) as unknown as Record<string, unknown>[];
  if (dieArmed && t.includes("insert into public.mcpx_rw_hix_frozen_snapshots")) { console.log(JSON.stringify({ pid: process.pid, event: "SIGKILL_inside_commit_after_first_frozen_insert" })); process.kill(process.pid, "SIGKILL"); }
  return { rows };
} };
const meter: Meter = {}; const rpc = heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, meter);
const ownerKind = (o: string) => { try { return PublicKey.isOnCurve(new PublicKey(o).toBytes()) ? ("WALLET" as const) : ("PROGRAM" as const); } catch { return "UNKNOWN" as const; } };
const mode = process.argv[2];
const genesisFile = "/tmp/pg5i/genesis.json";

if (mode === "INIT") {
  await sql.unsafe("do $$ begin create role anon; exception when others then null; end $$; do $$ begin create role authenticated; exception when others then null; end $$; do $$ begin create role service_role; exception when others then null; end $$;");
  await sql.unsafe(readFileSync("/dev-server/drizzle/migrations/0009_mcpx_05g_holder_index.sql", "utf8").replace(/--> statement-breakpoint/g, ""));
  await sql.unsafe(readFileSync("/dev-server/docs/pending-migrations/0010_mcpx_05i_cutoff_snapshots.sql", "utf8"));
  // stand-in coin facts for a TEST-ONLY policy: creator = fee payer of the create tx; pool = Pump bonding-curve PDA
  const first = (await rpc("getTransactionsForAddress", [MINT, { sortOrder: "asc", commitment: "finalized", transactionDetails: "full", encoding: "json", maxSupportedTransactionVersion: 1, limit: 1 }])).data[0];
  const creator = first.transaction.message.accountKeys[0] as string;
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(MINT).toBuffer()], new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"));
  const p: EligibilityPolicy = { ...POLICY_V1_DRAFT, version: "test-elig-v1-8m6w", status: "TEST_FIXTURE", mint: MINT, deployerWallet: creator,
    poolVaults: [{ address: curve.toBase58(), evidence: "TEST FIXTURE: Pump bonding-curve PDA derived from mint" }], effectiveFromWindow: 0 };
  await savePolicy(db, p);
  const t0 = first.blockTime as number; const W1 = Math.ceil(t0 / 300) * 300 + 600;
  await Bun.write(genesisFile, JSON.stringify({ W1, createdAt: t0, creator, curve: curve.toBase58() }));
  console.log(JSON.stringify({ init: "ok", createdBlockTime: t0, W1, W2: W1 + 300, creatorPrefix: creator.slice(0, 6), curve: curve.toBase58() }));
}
const g = JSON.parse(readFileSync(genesisFile, "utf8"));
const opts = { mint: MINT, anchorSlot: ANCHOR, genesisWindow: g.W1, maxCutoffsPerPass: 2, ownerKind, deps: cutoffDeps(rpc), nowSec: Math.floor(Date.now() / 1000) };
if (mode === "CUTOFFS") {
  const r = await selectPendingCutoffs(db, opts);
  const again = await import("../../../src/lib/rewards/cutoff").then((m) => Promise.all([g.W1, g.W1 + 300].map((w) => m.selectCutoff(w, opts.deps))));
  const saved = (await db.query("select extract(epoch from window_start)::bigint w, cutoff_slot, extract(epoch from cutoff_block_time)::bigint ct, next_slot, extract(epoch from next_block_time)::bigint nt, evidence->'skippedBetween' sk, finalized_head from public.mcpx_rw_hix_window_cutoffs order by 1")).rows;
  console.log(JSON.stringify({ selected: r, saved, lateReselect: again.map((x) => (x.kind === "SELECTED" ? x.evidence.cutoffSlot : x)), meter, credits: credits(meter) }));
}
if (mode === "PASS") {
  const t = Date.now();
  const r = await indexPass(db, rpc, meter, opts);
  console.log(JSON.stringify({ pid: process.pid, result: r, meter, credits: credits(meter), seconds: Math.round((Date.now() - t) / 1000) }, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
}
if (mode === "LATEHOLD") { // a late-discovered gap reaching before a frozen cutoff must open a hold, never rewrite
  const s = (await loadIndex(db, MINT))!; const c = (await db.query("select min(cutoff_slot)::bigint c from public.mcpx_rw_hix_frozen_snapshots")).rows[0]!.c;
  s.gaps.push({ fromSlot: Number(c) - 5, toSlot: Number(c) + 5, reason: "SIMULATED_LATE_PRE_CUTOFF_TX" });
  const w = await commitPass(db, { state: s, expectedCoveredTo: s.coveredTo, source: "rehearsal", txs: [], touched: new Set(), frozen: [], holds: [] });
  let mutate = "allowed"; try { await db.query("update public.mcpx_rw_hix_frozen_snapshots set digest='x'"); } catch (e) { mutate = "refused:" + String((e as Error).message).slice(0, 40); }
  console.log(JSON.stringify({ commit: w, holds: (await db.query("select extract(epoch from window_start)::bigint w, reason from public.mcpx_rw_hix_holds order by 1")).rows, frozenUpdate: mutate }));
}
if (mode === "REPORT") {
  const f = (await db.query("select extract(epoch from window_start)::bigint w, cutoff_slot, checkpoint_slot, policy_version, supply_at_cutoff::text s, indexed_total::text it, eligible_total::text e, excluded_total::text x, ambiguous_total::text a, completeness, digest, supply_proof from public.mcpx_rw_hix_frozen_snapshots order by 1")).rows;
  const owners = (await db.query("select extract(epoch from window_start)::bigint w, class, count(*)::int n from public.mcpx_rw_hix_frozen_owners group by 1,2 order by 1,2")).rows;
  const top = (await db.query("select extract(epoch from window_start)::bigint w, left(owner,6) o, amount::text a, class, reason from public.mcpx_rw_hix_frozen_owners where class<>'ELIGIBLE' order by 1,2")).rows;
  const diffs = (await db.query(`select count(*)::int changed from public.mcpx_rw_hix_frozen_owners a full join public.mcpx_rw_hix_frozen_owners b on a.owner=b.owner and b.window_start=a.window_start + interval '300 s'
    where (a.window_start = (select min(window_start) from public.mcpx_rw_hix_frozen_snapshots) or b.window_start = (select max(window_start) from public.mcpx_rw_hix_frozen_snapshots)) and coalesce(a.amount,-1) <> coalesce(b.amount,-1)`)).rows[0];
  const ck = (await db.query("select covered_to_slot from public.mcpx_rw_hix_checkpoints")).rows;
  const counts = (await db.query("select (select count(*) from public.mcpx_rw_hix_applied_txs)::int applied, (select count(*) from public.mcpx_rw_hix_balances)::int balances, (select count(*) from public.mcpx_rw_hix_frozen_snapshots)::int frozen, (select count(*) from public.mcpx_rw_hix_frozen_owners)::int owners, (select count(*) from public.mcpx_rw_hix_holds)::int holds, (select count(*) from public.mcpx_rw_hix_gaps)::int gaps")).rows[0];
  console.log(JSON.stringify({ frozen: f, ownerClasses: owners, nonEligible: top, ownersChangedBetweenWindows: diffs, checkpoint: ck, counts }));
}
await sql.end();
