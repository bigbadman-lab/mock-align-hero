// @ts-nocheck — operator CLI run with bun; not part of the worker bundle.
// Phase 05-I.1 operator-only recovery. READ-ONLY chain access; writes only recovery tables (0011).
//   bun scripts/recover-window.ts CANDIDATE <mint> <windowStartUnix> <anchorSlot>
//   bun scripts/recover-window.ts RESOLVE <candidateUuid> --confirm
// Env: MCPX_RECOVERY_DB_URL, MCPX_REWARDS_RPC_URL (or MCPX_HELIUS_TEST_API_KEY locally), MCPX_OPERATOR_ID. Never prints them.
import postgres from "postgres";
import { address, isOffCurveAddress } from "@solana/addresses";
import { heliusRpc, cutoffDeps, credits, type Meter } from "../src/helius-history";
import { gatherHistory } from "../src/recovery-source";
import { selectCutoff } from "../../../src/lib/rewards/cutoff";
import { buildCandidate } from "../../../src/lib/rewards/recovery";
import { loadRecoveryTarget, saveCandidate, resolveWindow } from "../../../src/lib/rewards/recovery.pg";
import { loadPolicies } from "../../../src/lib/rewards/cutoff-snapshot.pg";

const operator = process.env.MCPX_OPERATOR_ID?.trim(); if (!operator) { console.error("MCPX_OPERATOR_ID required"); process.exit(2); }
const dbUrl = process.env.MCPX_RECOVERY_DB_URL; if (!dbUrl) { console.error("MCPX_RECOVERY_DB_URL required"); process.exit(2); }
const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
const db = { query: async (t: string, p?: unknown[]) => ({ rows: (await sql.unsafe(t, (p ?? []) as never[])) as any[] }) };
const [mode, ...args] = process.argv.slice(2);
const correlationId = crypto.randomUUID();
const log = (o: object) => console.log(JSON.stringify({ svc: "mcpx-recovery", correlationId, operator, ...o }, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
try {
  if (mode === "CANDIDATE") {
    const [mint, ws, anchor] = args; const windowStart = Number(ws);
    const target = await loadRecoveryTarget(db, mint, windowStart);
    if (!target) { log({ event: "refused", reason: "NO_FROZEN_SNAPSHOT" }); process.exit(1); }
    if (!target.holds.length) { log({ event: "refused", reason: "WINDOW_NOT_HELD" }); process.exit(1); }
    const url = process.env.MCPX_REWARDS_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${process.env.MCPX_HELIUS_TEST_API_KEY}`;
    const meter: Meter = {}; const rpc = heliusRpc(url, meter);
    const reselected = await selectCutoff(windowStart, cutoffDeps(rpc));
    const history = await gatherHistory(rpc, meter, mint, Number(anchor));
    const policy = (await loadPolicies(db)).find((p) => p.version === target.frozen.policyVersion) ?? null;
    const ownerKind = (o: string) => { try { return isOffCurveAddress(address(o)) ? "PROGRAM" : "WALLET"; } catch { return "UNKNOWN"; } };
    const c = await buildCandidate({ frozen: target.frozen, holds: target.holds, reselected, history, policy, ownerKind });
    const provenance = { source: "helius:gTFA(mint)+gTFA(each account)+gMA@V", V: history.V, txs: history.txs.length, accounts: history.accounts, complete: history.complete, incompleteReason: history.reason, anchorSlot: Number(anchor), credits: credits(meter), rule: reselected.kind === "SELECTED" ? reselected.evidence.rule : null };
    const saved = await saveCandidate(db, mint, windowStart, c, { correlationId, operator, provenance });
    log({ event: "candidate", candidateId: saved.id, created: saved.created, status: c.status, reason: c.reason, comparison: { ...c.comparison, ownerDiffs: c.comparison.ownerDiffs.slice(0, 5) }, provenance, payable: false });
  } else if (mode === "RESOLVE") {
    if (!args.includes("--confirm")) { log({ event: "refused", reason: "CONFIRM_FLAG_REQUIRED" }); process.exit(1); }
    log({ event: "resolve", candidateId: args[0], result: await resolveWindow(db, args[0], operator) });
  } else { console.error("usage: CANDIDATE <mint> <windowStart> <anchorSlot> | RESOLVE <candidateId> --confirm"); process.exit(2); }
} finally { await sql.end(); }
