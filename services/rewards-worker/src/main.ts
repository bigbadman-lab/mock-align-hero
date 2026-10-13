// MCPX rewards worker (05-E). Render BACKGROUND WORKER — no HTTP listener, no public endpoint.
// DRY-RUN PLANNING ONLY: there is no signing, sending, swapping or payout code in this bundle, and it refuses to
// start in any other mode. Separate from the six-tool MCP worker, the transaction builder and the website.
import postgres from "postgres";
import { configBlockers, runPass, classify, type NativeConfig } from "../../../src/lib/rewards/processor";
import { pgStore, type Db } from "../../../src/lib/rewards/store.pg";
import { unavailableHistory } from "../../../src/lib/rewards/holder-history";
import { EPOCH_SECONDS } from "../../../src/lib/rewards/epochs";
import { signerStartupGate, SIGNER_SECRET_ENV } from "../../../src/lib/rewards/native-single";
import { heliusRpc, cutoffDeps, credits, type Meter } from "./helius-history";
import { indexPass, selectPendingCutoffs } from "./index-pass";
import { loadFrozen, loadPolicies } from "../../../src/lib/rewards/cutoff-snapshot.pg";
import { pipelineStatus } from "../../../src/lib/rewards/cutoff-snapshot";
import { policyFor, policyLiveAllowed } from "../../../src/lib/rewards/eligibility-policy";
import { PublicKey } from "@solana/web3.js";

const ownerKind = (o: string) => { try { return PublicKey.isOnCurve(new PublicKey(o).toBytes()) ? ("WALLET" as const) : ("PROGRAM" as const); } catch { return "UNKNOWN" as const; } };
const SCHEMA_0010 = ["mcpx_rw_hix_window_cutoffs", "mcpx_rw_hix_frozen_snapshots", "mcpx_rw_hix_frozen_owners", "mcpx_rw_hix_holds", "mcpx_rw_eligibility_policies"];

const env = (k: string) => process.env[k]?.trim() || null;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ svc: "mcpx-rewards-worker", at: new Date().toISOString(), ...o }));

export function readConfig() {
  const mode = env("MCPX_REWARDS_MODE") ?? "DRY_RUN";
  const cfg: NativeConfig = {
    // 05-F replacement: one deployer wallet (public address only). Sharing config / treasury envs are no longer read.
    feeModel: "SINGLE_DEPLOYER", deployerWallet: env("MCPX_NATIVE_DEPLOYER_WALLET"),
    mint: env("MCPX_NATIVE_MINT"), sharingConfig: null, rewardsTreasury: null, operationsTreasury: null,
    finalityLagSeconds: Number(env("MCPX_REWARDS_FINALITY_LAG_SECONDS") ?? 60),
    minPayableLamports: BigInt(env("MCPX_REWARDS_MIN_PAYABLE_LAMPORTS") ?? "0"),
  };
  const genesis = Number(env("MCPX_REWARDS_GENESIS_WINDOW") ?? NaN);
  const blockers = [...configBlockers(cfg)];
  if (env("MCPX_REWARDS_EMERGENCY_STOP") === "1") blockers.push("EMERGENCY_STOP");
  if (!env("MCPX_REWARDS_DB_URL")) blockers.push("DB_URL_UNSET");
  if (!env("MCPX_REWARDS_RPC_URL")) blockers.push("RPC_URL_UNSET");
  if (!Number.isInteger(genesis) || genesis % EPOCH_SECONDS !== 0) blockers.push("GENESIS_WINDOW_UNSET");
  if (!(cfg.finalityLagSeconds >= 30 && cfg.finalityLagSeconds <= 3600)) blockers.push("FINALITY_LAG_OUT_OF_RANGE");
  blockers.push("HOLDER_HISTORY_SOURCE_UNAVAILABLE", "ELIGIBILITY_POLICY_NOT_APPROVED", "EXECUTION_NOT_APPROVED");
  return { mode, cfg, genesis, blockers };
}

async function finalizedBlockTime(rpc: string): Promise<number | null> {
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { result?: unknown; error?: unknown };
    if (!r.ok || j.error !== undefined) throw new Error("rpc_error");
    return j.result;
  };
  try {
    const slot = await call("getSlot", [{ commitment: "finalized" }]);
    const t = await call("getBlockTime", [slot]);
    return typeof t === "number" ? t : null;
  } catch { return null; } // unknown, never "zero"
}

async function main() {
  const { mode, cfg, genesis, blockers } = readConfig();
  if (mode !== "DRY_RUN") { log({ level: "fatal", event: "refused_mode", mode }); process.exit(2); }
  const gate = signerStartupGate(process.env[SIGNER_SECRET_ENV]); // value never logged
  if (!gate.start) { log({ level: "fatal", event: "refused_signer_secret", reason: gate.reason }); process.exit(3); }
  const workerId = `rw-${env("RENDER_INSTANCE_ID") ?? process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const pollMs = Math.min(Math.max(Number(env("MCPX_REWARDS_POLL_SECONDS") ?? 300), 60), 900) * 1000; // 05-I: 5-minute default, no hot loop
  const maxWindows = Math.min(Math.max(Number(env("MCPX_REWARDS_MAX_WINDOWS_PER_PASS") ?? 12), 1), 288);
  let stopping = false, backoff = pollMs;
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => { stopping = true; log({ event: "shutdown_requested", signal: s }); });

  // Financial prerequisites missing → stay alive (health) but do nothing (readiness BLOCKED). No DB writes.
  const financialBlockers = blockers.filter((b) => !["HOLDER_HISTORY_SOURCE_UNAVAILABLE", "ELIGIBILITY_POLICY_NOT_APPROVED", "EXECUTION_NOT_APPROVED"].includes(b));
  if (financialBlockers.length) {
    log({ event: "ready_state", ready: false, health: true, mode, blockers });
    while (!stopping) await new Promise((r) => setTimeout(r, pollMs));
    return;
  }
  // max:1 — every BEGIN/COMMIT must run on the same connection as the statements inside it
  const sql = postgres(env("MCPX_REWARDS_DB_URL")!, { max: 1, prepare: false, idle_timeout: 30 });
  const db: Db = { query: async (t, p) => ({ rows: (await sql.unsafe(t, (p ?? []) as never[])) as unknown as Record<string, unknown>[] }) };
  const store = pgStore(db, workerId, 60);
  const have = (await db.query("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)", [SCHEMA_0010])).rows.length;
  if (have !== SCHEMA_0010.length) blockers.push("SCHEMA_0010_NOT_APPLIED");
  log({ event: "started", workerId, mode, blockers });
  let lastPlanned: number | null = null, totalCredits = 0;
  while (!stopping) {
    const correlationId = crypto.randomUUID();
    try {
      // 05-I: cutoff selection + holder-index pass + snapshot freezing (writes only mcpx_rw_hix_* / policy tables).
      let diag: Record<string, unknown> = {};
      if (cfg.mint && !blockers.includes("SCHEMA_0010_NOT_APPLIED")) {
        const meter: Meter = {}; const rpc = heliusRpc(env("MCPX_REWARDS_RPC_URL")!, meter);
        const anchor = env("MCPX_NATIVE_ANCHOR_SLOT");
        const opts = { mint: cfg.mint, anchorSlot: anchor === null ? null : Number(anchor), genesisWindow: genesis, maxCutoffsPerPass: Math.min(maxWindows, 12), ownerKind, deps: cutoffDeps(rpc), nowSec: Math.floor(Date.now() / 1000) };
        const cut = await selectPendingCutoffs(db, opts);
        const h = await indexPass(db, rpc, meter, opts);
        const passCredits = credits(meter); totalCredits += passCredits;
        const g = (await db.query("select count(*)::int n from public.mcpx_rw_hix_gaps where mint=$1 and repaired_at is null", [cfg.mint])).rows[0]?.n ?? 0;
        const holds = (await db.query("select count(*)::int n from public.mcpx_rw_hix_holds where mint=$1 and resolved_at is null", [cfg.mint])).rows[0]?.n ?? 0;
        const lastCut = (await db.query("select max(cutoff_slot)::text c from public.mcpx_rw_hix_window_cutoffs where mint=$1 and status='SELECTED'", [cfg.mint])).rows[0]?.c ?? null;
        const pol = policyFor(opts.nowSec, await loadPolicies(db));
        diag = { latestCutoffSlot: lastCut, indexSlot: "toSlot" in h ? h.toSlot : null, holderAccounts: "accounts" in h ? h.accounts : null, openGaps: g, openHolds: holds, cutoffs: cut, pass: h.kind,
          frozen: "frozen" in h ? h.frozen : [], passCredits, totalCredits, policy: pol ? { version: pol.version, status: pol.status, live: policyLiveAllowed(pol) } : null,
          status: pipelineStatus({ mint: cfg.mint, openGaps: g, indexBehind: h.kind !== "SYNCED", lastWindowHeld: holds > 0, policy: pol }) };
      } else diag = { status: pipelineStatus({ mint: cfg.mint, openGaps: 0, indexBehind: true, lastWindowHeld: false, policy: null }) };
      log({ event: "diagnostics", correlationId, lastPlannedWindow: lastPlanned, ...diag });
      const out = await runPass(store, cfg, {
        workerId, now: Math.floor(Date.now() / 1000), leaseSeconds: 60, genesisWindow: genesis,
        finalizedBlockTime: await finalizedBlockTime(env("MCPX_REWARDS_RPC_URL")!),
        // frozen window snapshot only (never current balances); live payouts stay impossible in DRY_RUN
        snapshot: async (windowEnd: number) => { const w = windowEnd - 300;
          if (!cfg.mint || blockers.includes("SCHEMA_0010_NOT_APPLIED")) return null;
          const f = await loadFrozen(db, cfg.mint, w); if (!f || f.completeness !== "COMPLETE") return null;
          const holders = f.owners.filter((o) => o.class === "ELIGIBLE").map((o) => ({ owner: o.owner, amount: o.amount }));
          const excluded = f.owners.filter((o) => o.class === "EXCLUDED").map((o) => ({ owner: o.owner, amount: o.amount, why: o.reason ?? "" }));
          return { status: "COMPLETE" as const, reasons: [], mint: cfg.mint, slot: f.cutoffSlot, source: `frozen:${f.digest}`, configVersion: f.policyVersion, holders, excluded, ambiguous: [],
            eligibleTotal: f.eligibleTotal, excludedTotal: f.supply - f.eligibleTotal, ambiguousTotal: 0n, livePayoutAllowed: false };
        },
        costs: () => ({ estimateLamports: null, reserveLamports: null }),
      }, maxWindows);
      for (const r of out) {
        const w = r.kind === "SEALED" ? r.plan.window : null;
        await db.query("insert into public.mcpx_rw_proc_runs (worker_id, correlation_id, window_start, outcome, reason) values ($1,$2,$3,$4,$5)",
          [workerId, correlationId, w === null ? null : new Date(w * 1000).toISOString(), r.kind, classify(r).join(",") || null]);
        if (w !== null) lastPlanned = w;
        log({ event: "pass", correlationId, outcome: r.kind, window: w, classes: classify(r) });
      }
      backoff = pollMs;
    } catch (e) {
      backoff = Math.min(backoff * 2, 10 * 60_000);
      log({ level: "error", event: "pass_failed", correlationId, error: e instanceof Error ? e.message : "unknown", retryInMs: backoff });
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
  await sql.end({ timeout: 5 });
  log({ event: "stopped", workerId });
}

void unavailableHistory;
if (process.env["MCPX_REWARDS_WORKER_NO_AUTOSTART"] !== "1") void main();
