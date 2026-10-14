// MCPX rewards worker (05-E). Render BACKGROUND WORKER — no HTTP listener, no public endpoint.
// DRY-RUN PLANNING + validated deployer signer (signer.ts). No sending, swapping or payout broadcast in this bundle;
// refuses to start in any mode other than DRY_RUN. Separate from the six-tool MCP worker, the transaction builder and the website.
import { remoteDb, sealedPost, type RemoteConfig } from "../../../src/lib/rewards/remote";
import { waitForLaunch, type Pending } from "./launch-wake";
import { deriveLaunch } from "./launch-derive";
import { configBlockers, runPass, classify, type NativeConfig } from "../../../src/lib/rewards/processor";
import { pgStore } from "../../../src/lib/rewards/store.pg";
import { unavailableHistory } from "../../../src/lib/rewards/holder-history";
import { EPOCH_SECONDS } from "../../../src/lib/rewards/epochs";
import { loadSigner, readLimits, executionReadiness } from "./signer";
import { intentStore } from "./intents";
import { reconcileOpen, type Chain } from "./executor";
import { runPassWindows } from "./orchestrator";
import { submitStage } from "./build";
import { Connection, PublicKey } from "@solana/web3.js";
import { sealedFromFrozen, vaultLamports, settlementChain, captureFills, pendingFills, ingestFees, deployerProvenance, creatorVaults, type RpcCall } from "./pipeline";
import { heliusRpc, cutoffDeps, credits, type Meter } from "./helius-history";
import { indexPass, selectPendingCutoffs } from "./index-pass";
import { loadFrozen, loadPolicies } from "../../../src/lib/rewards/cutoff-snapshot.pg";
import { windowPayableForPlanning } from "../../../src/lib/rewards/recovery.pg";
import { pipelineStatus } from "../../../src/lib/rewards/cutoff-snapshot";
import { policyFor, policyLiveAllowed } from "../../../src/lib/rewards/eligibility-policy";
import { childFeeCycle, readChildEnv } from "./child-wire";
import { address, isOffCurveAddress } from "@solana/addresses"; // address-only; keeps web3.js (send/sign code) out of the bundle

const ownerKind = (o: string) => { try { return isOffCurveAddress(address(o)) ? ("PROGRAM" as const) : ("WALLET" as const); } catch { return "UNKNOWN" as const; } };

const env = (k: string) => process.env[k]?.trim() || null;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ svc: "mcpx-rewards-worker", at: new Date().toISOString(), ...o }));
import { fetchSiteState } from "./site-state";
import { freshFetch } from "./fresh-fetch";

export function readConfig() {
  const mode = env("MCPX_REWARDS_MODE") ?? "DRY_RUN";
  const cfg: NativeConfig = {
    // 05-F replacement: one deployer wallet (public address only). Sharing config / treasury envs are no longer read.
    feeModel: "SINGLE_DEPLOYER", deployerWallet: env("MCPX_NATIVE_DEPLOYER_WALLET"),
    mint: env("MCPX_NATIVE_MINT"), sharingConfig: null, rewardsTreasury: null, operationsTreasury: null,
    finalityLagSeconds: Number(env("MCPX_REWARDS_FINALITY_LAG_SECONDS") ?? 60),
    minPayableLamports: BigInt(env("MCPX_REWARDS_MIN_PAYABLE_LAMPORTS") ?? "0"),
  };
  const blockers: string[] = [];
  if (env("MCPX_REWARDS_EMERGENCY_STOP") === "1") blockers.push("EMERGENCY_STOP");
  // Option 1: no database login on Render — every read/write goes through the sealed site bridge.
  if (!env("MCPX_SITE_URL")) blockers.push("SITE_URL_UNSET");
  if ((env("MCPX_REWARDS_SHARED_SECRET") ?? "").length < 32) blockers.push("SHARED_SECRET_UNSET");
  if (!env("MCPX_REWARDS_RPC_URL")) blockers.push("RPC_URL_UNSET");
  if (!(cfg.finalityLagSeconds >= 30 && cfg.finalityLagSeconds <= 3600)) blockers.push("FINALITY_LAG_OUT_OF_RANGE");
  blockers.push("HOLDER_HISTORY_SOURCE_UNAVAILABLE", "ELIGIBILITY_POLICY_NOT_APPROVED", "EXECUTION_NOT_APPROVED");
  return { mode, cfg, blockers };
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

/** Plain finalized JSON-RPC call (read-only). Errors throw; callers map them to UNKNOWN, never to zero. */
function rpcCall(rpc: string): RpcCall {
  return async (method, params) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
    if (!r.ok || j.error !== undefined) throw new Error(j.error?.message ?? "rpc_error");
    return j.result;
  };
}

async function main() {
  const { mode, cfg, blockers } = readConfig();
  if (mode !== "DRY_RUN") { log({ level: "fatal", event: "refused_mode", mode }); process.exit(2); }
  // Key presence never starts transactions: the signer is loaded, checked against MCPX_DEPLOYER_PUBLIC_KEY and only
  // reported. There is no broadcast path in this bundle; readiness stays blocked until every real check passes.
  const signer = loadSigner(process.env);
  const limits = readLimits(process.env);
  const readiness = executionReadiness({ signer: signer.state, mintVerified: false, eligibilityApproved: false, snapshotComplete: false,
    feeOwnershipConfirmed: false, intentStoreReady: false, simulationsPassed: false, reservesSufficient: false, operatorAuthorized: false,
    limitsSet: limits.ok, emergencyStop: env("MCPX_REWARDS_EMERGENCY_STOP") === "1" });
  log({ event: "signer_status", ...signer.describe(), execution: readiness.state, executionBlockers: readiness.blockers });
  const workerId = `rw-${env("RENDER_INSTANCE_ID") ?? process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const pollMs = Math.min(Math.max(Number(env("MCPX_REWARDS_POLL_SECONDS") ?? 300), 60), 900) * 1000; // 05-I: 5-minute default, no hot loop
  const maxWindows = Math.min(Math.max(Number(env("MCPX_REWARDS_MAX_WINDOWS_PER_PASS") ?? 12), 1), 288);
  // New launches are confirmed on a shorter cadence than reward windows (default 60 s, bounded 30–900 s).
  const launchPollMs = Math.min(Math.max(Number(env("MCPX_LAUNCH_POLL_SECONDS") ?? 60), 30), 900) * 1000;
  let stopping = false, backoff = pollMs;
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => { stopping = true; log({ event: "shutdown_requested", signal: s }); });

  const pre = blockers.filter((b) => !["HOLDER_HISTORY_SOURCE_UNAVAILABLE", "ELIGIBILITY_POLICY_NOT_APPROVED", "EXECUTION_NOT_APPROVED"].includes(b));
  if (pre.length) { // cannot even reach the site → stay alive, do nothing
    log({ event: "ready_state", ready: false, health: true, mode, blockers });
    while (!stopping) await new Promise((r) => setTimeout(r, pollMs));
    return;
  }
  const bridge: RemoteConfig = { siteUrl: env("MCPX_SITE_URL")!, secret: env("MCPX_REWARDS_SHARED_SECRET")!, fetchImpl: freshFetch };
  const db = remoteDb(bridge);
  // Launch config comes from the site. Setting the $MCP mint there is the ONLY go-live step: anchor slot, genesis
  // window and deployer wallet are derived from the mint's creation transaction unless explicitly configured.
  let genesis = NaN;
  // CHILD-FEES-01B: child-fee keeper runs on the same schedule, plan-only, isolated from native rewards.
  const childPass = async (quote: string | null, feePayer: string | null) => {
    try {
      const r = await childFeeCycle(db, rpcCall(env("MCPX_REWARDS_RPC_URL")!), { canonicalQuote: quote, feePayer, env: readChildEnv(env) });
      log({ event: "child_fees", signing: "DISABLED", broadcast: "DISABLED", results: r.slice(0, 50) });
    } catch (e) { log({ level: "error", event: "child_fees_failed", error: e instanceof Error ? e.message : "unknown" }); }
  };
  for (;;) {
    if (stopping) return;
    let op = "site_state";
    const t0 = Date.now();
    try {
      // 2A: the state read is a ~200 ms request; bound it (15 s) with one retry instead of the bridge's 120 s default.
      const st = (await fetchSiteState(bridge, sealedPost)) as { config: { mint: string | null; deployerWallet: string | null; anchorSlot: string | null; genesisWindow: string | null; emergencyStop: boolean } | null; schemaReady: boolean };
      op = "launch_config";
      const c = st.config;
      const wait: string[] = [];
      if (!st.schemaReady) wait.push("SCHEMA_0010_NOT_APPLIED");
      if (!c?.mint) wait.push("MINT_UNSET");
      if (c?.emergencyStop) wait.push("EMERGENCY_STOP");
      if (!wait.length) {
        const d = await deriveLaunch(heliusRpc(env("MCPX_REWARDS_RPC_URL")!, {}), c!.mint!);
        cfg.mint = c!.mint; cfg.deployerWallet = c!.deployerWallet ?? d?.deployer ?? null;
        process.env["MCPX_NATIVE_ANCHOR_SLOT"] = c!.anchorSlot ?? (d ? String(d.anchorSlot) : "");
        genesis = c!.genesisWindow !== null ? Number(c!.genesisWindow) : d ? d.genesisWindow : NaN;
        if (!d && (c!.anchorSlot === null || c!.genesisWindow === null)) wait.push("LAUNCH_DERIVE_FAILED");
        else if (!Number.isInteger(genesis) || genesis % EPOCH_SECONDS !== 0) wait.push("GENESIS_WINDOW_INVALID");
        const cb = configBlockers(cfg); if (cb.length) wait.push(...cb);
        if (!wait.length) { log({ event: "launch_config", mint: cfg.mint, deployerWallet: cfg.deployerWallet, anchorSlot: process.env["MCPX_NATIVE_ANCHOR_SLOT"], genesisWindow: genesis, derived: !c!.anchorSlot || !c!.genesisWindow || !c!.deployerWallet }); break; }
      }
      log({ event: "ready_state", ready: false, health: true, mode, blockers: wait });
      await childPass(c?.mint ?? null, c?.deployerWallet ?? env("MCPX_DEPLOYER_PUBLIC_KEY"));
    } catch (e) { log({ level: "error", event: "state_failed", op, elapsedMs: Date.now() - t0, errorName: e instanceof Error ? e.name : "unknown", error: e instanceof Error ? e.message : "unknown" }); }
    // Fast wake: a fresh launch claim ends the wait within ~5 s instead of the full launch poll interval.
    const lastPassAt = Date.now();
    const woke = await waitForLaunch({ maxMs: Math.min(pollMs, launchPollMs), lastPassAt, stopping: () => stopping,
      check: async () => (await sealedPost({ ...bridge, timeoutMs: 5_000 }, "/api/public/rewards/launch-pending", {})) as Pending });
    if (woke === "woken") log({ event: "launch_wake" });
  }
  const store = pgStore(db, workerId, 60);
  log({ event: "started", workerId, mode, blockers });
  let lastPlanned: number | null = null, totalCredits = 0;
  while (!stopping) {
    const correlationId = crypto.randomUUID();
    try {
      // 05-I: cutoff selection + holder-index pass + snapshot freezing (writes only mcpx_rw_hix_* / policy tables).
      let diag: Record<string, unknown> = {};
      if (cfg.mint) {
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
          if (!cfg.mint) return null;
          if (!(await windowPayableForPlanning(db, cfg.mint, w))) return null; // 05-I.1: any open hold blocks planning
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
      // EXEC-01D: one pass = reconcile → fees → fills → windows. All reads finalized; no sender exists (null) so
      // nothing is ever broadcast in this bundle. Readiness is computed from real checks and is not READY here.
      const call = rpcCall(env("MCPX_REWARDS_RPC_URL")!);
      const conn = new Connection(env("MCPX_REWARDS_RPC_URL")!, "finalized");
      const deployer = cfg.deployerWallet!;
      const rec = await reconcileOpen(intentStore(db, workerId), settlementChain(call, db, deployer), null);
      const prov = await deployerProvenance(call, deployer);
      const fees = await ingestFees(db, store, {
        signatures: async (a, o) => (await call("getSignaturesForAddress", [a, { commitment: "finalized", limit: o.limit, ...(o.until ? { until: o.until } : {}), ...(o.before ? { before: o.before } : {}) }])) as never,
        transaction: async (sig) => call("getTransaction", [sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]),
      }, { mint: cfg.mint!, deployer, provenance: prov,
        wsolOwner: async (ata) => { try { const i = (await call("getAccountInfo", [ata, { commitment: "finalized", encoding: "jsonParsed" }])) as { value: { data: { parsed: { info: { owner: string; mint: string } } } } | null };
          return i.value ? { owner: i.value.data.parsed.info.owner, mint: i.value.data.parsed.info.mint } : null; } catch { return null; } } });
      let decimals: number | null = null;
      try { decimals = ((await call("getTokenSupply", [cfg.mint, { commitment: "finalized" }])) as { value: { decimals: number } }).value.decimals; } catch { /* unknown */ }
      const fills = decimals === null ? [] : await captureFills(db, call, { deployer, mint: cfg.mint!, decimals });
      const vaults = await creatorVaults(deployer);
      if (lastPlanned !== null) {
        const budgetOf = async (w: number) => { const b = (await db.query("select sol::text, buyback::text, tokens::text, ops::text, evidence from public.mcpx_rw_budget_remaining(to_timestamp($1))", [w])).rows[0];
          return b ? { sol: BigInt(String(b["sol"])), buyback: BigInt(String(b["buyback"])), tokens: BigInt(String(b["tokens"])), ops: BigInt(String(b["ops"])), evidence: !!b["evidence"] } : null; };
        const fin = await runPassWindows({
          readiness: () => readiness, maxRecipientsPerTx: 20,
          sealed: async (w) => { if (!(await windowPayableForPlanning(db, cfg.mint!, w))) return null;
            const b = await budgetOf(w);
            return sealedFromFrozen(await loadFrozen(db, cfg.mint!, w), { deployer, excluded: [vaults.curveVault, vaults.ammAuthority, vaults.ammWsolVault], solTotal: b?.sol ?? 0n, minPayable: cfg.minPayableLamports }); },
          openForCycle: async (c) => Number((await db.query("select count(*)::int n from public.mcpx_rw_intents where cycle_id=$1 and state='SIGNED'", [c])).rows[0]?.["n"] ?? 0),
          vaultLamports: async () => (await vaultLamports(call, deployer))?.total ?? null,
          pendingFills: (w) => pendingFills(db, w),
          budget: budgetOf,
          // 01E: build → validate → sign → persist bytes. Sender is null: signed bytes are HELD, never broadcast. Only
          // reachable when readiness is READY (it is not in this bundle) and the signer validated against the public key.
          submit: (kind, key, cycle, w, rows, lamports) => submitStage({ conn, deployer: new PublicKey(deployer), mint: new PublicKey(cfg.mint!), decimals: decimals ?? -1,
            cuPrice: 1000, sign: decimals === null ? null : signer.sign, store: intentStore(db, workerId), sender: null,
            ctx: async () => ({ limits: limits.ok ? limits.limits : null, emergencyStop: env("MCPX_REWARDS_EMERGENCY_STOP") === "1",
              currentBlockHeight: await conn.getBlockHeight("finalized").catch(() => null), store: intentStore(db, workerId), ataRentLamports: await conn.getMinimumBalanceForRentExemption(170, "finalized").then(BigInt).catch(() => null) }) }, kind, key, cycle, w, rows, lamports),
        }, [lastPlanned], 1);
        log({ event: "financial_cycle", correlationId, windows: fin.map((x) => ({ window: x.window, last: x.stages.at(-1) })) });
      }
      log({ event: "fees", correlationId, provenance: prov.createdMints === null ? "UNKNOWN" : prov.createdMints.length, result: fees.kind, events: "events" in fees ? fees.events.length : 0, fills: fills.map((f) => f.result) });
      log({ event: "execution", correlationId, readiness: readiness.state, blockers: readiness.blockers, reconciled: rec.length, actions: rec.map((x) => x.action) });
      await childPass(cfg.mint, cfg.deployerWallet);
      backoff = pollMs;
    } catch (e) {
      backoff = Math.min(backoff * 2, 10 * 60_000);
      log({ level: "error", event: "pass_failed", correlationId, error: e instanceof Error ? e.message : "unknown", retryInMs: backoff });
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
  log({ event: "stopped", workerId });
}

void unavailableHistory;
if (process.env["MCPX_REWARDS_WORKER_NO_AUTOSTART"] !== "1") void main();
