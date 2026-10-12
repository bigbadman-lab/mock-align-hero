// MCPX rewards worker (05-E). Render BACKGROUND WORKER — no HTTP listener, no public endpoint.
// DRY-RUN PLANNING ONLY: there is no signing, sending, swapping or payout code in this bundle, and it refuses to
// start in any other mode. Separate from the six-tool MCP worker, the transaction builder and the website.
import postgres from "postgres";
import { configBlockers, runPass, classify, type NativeConfig } from "../../../src/lib/rewards/processor";
import { pgStore, type Db } from "../../../src/lib/rewards/store.pg";
import { unavailableHistory } from "../../../src/lib/rewards/holder-history";
import { EPOCH_SECONDS } from "../../../src/lib/rewards/epochs";

const env = (k: string) => process.env[k]?.trim() || null;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ svc: "mcpx-rewards-worker", at: new Date().toISOString(), ...o }));

export function readConfig() {
  const mode = env("MCPX_REWARDS_MODE") ?? "DRY_RUN";
  const cfg: NativeConfig = {
    mint: env("MCPX_NATIVE_MINT"), sharingConfig: env("MCPX_NATIVE_SHARING_CONFIG"),
    rewardsTreasury: env("MCPX_REWARDS_TREASURY"), operationsTreasury: env("MCPX_OPERATIONS_TREASURY"),
    finalityLagSeconds: Number(env("MCPX_REWARDS_FINALITY_LAG_SECONDS") ?? 60),
    minPayableLamports: BigInt(env("MCPX_REWARDS_MIN_PAYABLE_LAMPORTS") ?? "0"),
  };
  const genesis = Number(env("MCPX_REWARDS_GENESIS_WINDOW") ?? NaN);
  const blockers = [...configBlockers(cfg)];
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
  const workerId = `rw-${env("RENDER_INSTANCE_ID") ?? process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const pollMs = Math.min(Math.max(Number(env("MCPX_REWARDS_POLL_SECONDS") ?? 30), 10), 300) * 1000;
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
  const sql = postgres(env("MCPX_REWARDS_DB_URL")!, { max: 2, prepare: false, idle_timeout: 30 });
  const db: Db = { query: async (t, p) => ({ rows: (await sql.unsafe(t, (p ?? []) as never[])) as unknown as Record<string, unknown>[] }) };
  const store = pgStore(db, workerId, 60);
  log({ event: "started", workerId, mode, blockers });
  while (!stopping) {
    const correlationId = crypto.randomUUID();
    try {
      const out = await runPass(store, cfg, {
        workerId, now: Math.floor(Date.now() / 1000), leaseSeconds: 60, genesisWindow: genesis,
        finalizedBlockTime: await finalizedBlockTime(env("MCPX_REWARDS_RPC_URL")!),
        snapshot: async () => null, // holder history: unavailableHistory → HELD, never current balances
        costs: () => ({ estimateLamports: null, reserveLamports: null }),
      }, maxWindows);
      for (const r of out) {
        const w = r.kind === "SEALED" ? r.plan.window : null;
        await db.query("insert into public.mcpx_rw_proc_runs (worker_id, correlation_id, window_start, outcome, reason) values ($1,$2,$3,$4,$5)",
          [workerId, correlationId, w === null ? null : new Date(w * 1000).toISOString(), r.kind, classify(r).join(",") || null]);
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
