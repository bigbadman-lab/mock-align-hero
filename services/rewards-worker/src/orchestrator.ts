// REWARDS-EXEC-01C C03 — five-minute financial orchestration over SEALED windows (in order, bounded per pass).
// Stages: SETTLE_OPEN → COLLECT → BUY → FILL → PAY_SOL → PAY_TOKEN. Every stage is idempotent: batch ids are
// deterministic, so a crash between stages re-runs into DUPLICATE reservations instead of new payments.
// The first non-DONE stage stops the window with a precise reason; liabilities stay for the next pass.
import { chunkEntitlements } from "./budget";

export type StageResult = { stage: Stage; status: "DONE" | "HELD" | "WAITING"; reason?: string; detail?: Record<string, unknown> };
export type Stage = "READINESS" | "SNAPSHOT" | "SETTLE_OPEN" | "COLLECT" | "BUY" | "FILL" | "PAY_SOL" | "PAY_TOKEN";
export type Rows = { owner: string; amount: bigint }[];
export type SubmitOutcome = "NEW_SIGNED" | "DUPLICATE" | "REFUSED" | "NO_BUDGET";

export type OrchestratorDeps = {
  /** executionReadiness(...).state — anything but READY holds every money stage (no fake-ready path). */
  readiness(): { state: string; blockers: string[] };
  /** Sealed plan for the window: frozen snapshot entitlements (never current balances). null = not sealed yet. */
  sealed(window: number): Promise<{ solRows: Rows; tokenRowsFor(inventory: bigint): Rows; snapshotComplete: boolean } | null>;
  /** Open SIGNED intents for the cycle; any present → wait (never stack new payments on uncertain ones). */
  openForCycle(cycleId: string): Promise<number>;
  vaultLamports(): Promise<bigint | null>;
  budget(window: number): Promise<{ sol: bigint; buyback: bigint; tokens: bigint; ops: bigint; evidence: boolean } | null>;
  /** reserve→build→validate→sign→persist bytes (→send only if a sender exists). */
  submit(kind: "FEE_COLLECTION" | "BUYBACK" | "SOL_PAYOUT" | "TOKEN_PAYOUT", key: string, cycleId: string, window: number, rows: Rows, lamports: bigint): Promise<SubmitOutcome>;
  /** Unrecorded LANDED buyback for the window (fill not yet captured) → capture now; returns pending count. */
  pendingFills(window: number): Promise<number>;
  maxRecipientsPerTx: number;
};

export async function runWindow(d: OrchestratorDeps, window: number): Promise<StageResult[]> {
  const out: StageResult[] = []; const cycleId = `w${window}`;
  const stop = (r: StageResult) => { out.push(r); return out; };
  const r = d.readiness();
  if (r.state !== "EXECUTION_READY") return stop({ stage: "READINESS", status: "HELD", reason: "EXECUTION_NOT_READY", detail: { blockers: r.blockers } });
  const s = await d.sealed(window);
  if (!s) return stop({ stage: "SNAPSHOT", status: "WAITING", reason: "WINDOW_NOT_SEALED" });
  if (!s.snapshotComplete) return stop({ stage: "SNAPSHOT", status: "HELD", reason: "SNAPSHOT_INCOMPLETE" });
  out.push({ stage: "SNAPSHOT", status: "DONE" });
  const open = await d.openForCycle(cycleId);
  if (open > 0) return stop({ stage: "SETTLE_OPEN", status: "WAITING", reason: "UNSETTLED_TRANSACTIONS", detail: { open } });
  out.push({ stage: "SETTLE_OPEN", status: "DONE" });

  const vault = await d.vaultLamports();
  if (vault === null) return stop({ stage: "COLLECT", status: "WAITING", reason: "RPC_UNAVAILABLE" });
  if (vault > 0n) {
    const o = await d.submit("FEE_COLLECTION", `${cycleId}:collect`, cycleId, window, [], 0n);
    if (o === "REFUSED" || o === "NO_BUDGET") return stop({ stage: "COLLECT", status: "HELD", reason: o });
    if (o === "NEW_SIGNED") return stop({ stage: "COLLECT", status: "WAITING", reason: "AWAITING_FINALIZED_COLLECTION" });
  }
  out.push({ stage: "COLLECT", status: "DONE" });

  const b = await d.budget(window);
  if (!b) return stop({ stage: "BUY", status: "WAITING", reason: "BUDGET_UNAVAILABLE" });
  if (!b.evidence) return stop({ stage: "BUY", status: "WAITING", reason: "NO_FINALIZED_FEES_FOR_WINDOW" });
  if (b.buyback > 0n) {
    const o = await d.submit("BUYBACK", `${cycleId}:buy`, cycleId, window, [], b.buyback);
    if (o === "REFUSED" || o === "NO_BUDGET") return stop({ stage: "BUY", status: "HELD", reason: o });
    if (o === "NEW_SIGNED") return stop({ stage: "BUY", status: "WAITING", reason: "AWAITING_FINALIZED_BUY" });
  }
  out.push({ stage: "BUY", status: "DONE" });
  const pf = await d.pendingFills(window);
  if (pf > 0) return stop({ stage: "FILL", status: "WAITING", reason: "FILL_NOT_YET_CAPTURED", detail: { pending: pf } });
  out.push({ stage: "FILL", status: "DONE" });

  for (const [stage, kind, rows] of [["PAY_SOL", "SOL_PAYOUT", s.solRows], ["PAY_TOKEN", "TOKEN_PAYOUT", s.tokenRowsFor((await d.budget(window))?.tokens ?? 0n)]] as const) {
    const batches = chunkEntitlements(window, kind, rows, d.maxRecipientsPerTx);
    let signed = 0;
    for (const { idempotencyKey, rows: part } of batches) {
      const total = part.reduce((a, x) => a + x.amount, 0n);
      const o = await d.submit(kind, idempotencyKey, cycleId, window, part, kind === "SOL_PAYOUT" ? total : 0n);
      if (o === "REFUSED" || o === "NO_BUDGET") return stop({ stage, status: "HELD", reason: o, detail: { batches: batches.length, signed } });
      if (o === "NEW_SIGNED") signed++;
    }
    if (signed > 0) return stop({ stage, status: "WAITING", reason: "AWAITING_FINALIZED_PAYOUTS", detail: { batches: batches.length, signed } });
    out.push({ stage, status: "DONE", detail: { batches: batches.length } });
  }
  return out;
}

/** Ordered, bounded catch-up: processes at most `max` windows, stops at the first window that is not fully DONE. */
export async function runPassWindows(d: OrchestratorDeps, windows: readonly number[], max: number) {
  const res: { window: number; stages: StageResult[] }[] = [];
  for (const w of [...windows].sort((a, b) => a - b).slice(0, max)) {
    const st = await runWindow(d, w); res.push({ window: w, stages: st });
    if (st[st.length - 1]!.status !== "DONE") break;
  }
  return res;
}
