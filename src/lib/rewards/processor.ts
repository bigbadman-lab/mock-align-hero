// Phase 05-D — five-minute native rewards processor. DRY-RUN ONLY: produces non-executable plans; never signs,
// sends, swaps or pays. Pure core with an injectable store (memory here; Postgres later behind the same contract).
//
// Inputs are ONLY verified fee-sharing distributions decoded by pump-sharing.ts (05-C trust model) that passed
// checkNativeSplit against configured treasuries. Unverified logs, balance diffs, AMM sweeps or unfinalized
// signatures can never reach the ledger.
import { EPOCH_SECONDS, epochStart } from "./epochs";
import { checkNativeSplit, splitRewardsReceipt, type Distribution } from "./pump-sharing";
import type { EligibilitySnapshot } from "./eligibility";

export type NativeConfig = {
  mint: string | null; sharingConfig: string | null; rewardsTreasury: string | null; operationsTreasury: string | null;
  /** Seconds a window end must be behind finalized chain time before it can be sealed. */
  finalityLagSeconds: number;
  /** Lamports below which a holder's SOL entitlement is carried forward to that same owner. */
  minPayableLamports: bigint;
};

export type Receipt = {
  key: string; signature: string; slot: number; blockTime: number; window: number;
  rewardsLamports: bigint; operationsLamports: bigint; solBudget: bigint; buybackBudget: bigint;
};

export type WindowState = "OPEN" | "PLANNED" | "HELD" | "ZERO";
export type PlanStatus = "PLANNED" | "HELD" | "CANCELLED" | "APPROVED" | "SUBMITTED" | "CONFIRMED" | "RECONCILED";

export type Plan = {
  planId: string; window: number; revision: number; mode: "DRY_RUN"; status: PlanStatus;
  receiptKeys: string[]; adjustmentKeys: string[];
  rewardsTotal: bigint; operationsTotal: bigint; solBudget: bigint; buybackBudget: bigint;
  snapshotSlot: number | null; snapshotConfigVersion: string | null;
  solEntitlements: { owner: string; lamports: bigint }[]; solCarriedOut: { owner: string; lamports: bigint }[]; solDust: bigint;
  buyback: { budgetLamports: bigint; state: "AWAITING_EXECUTION_APPROVAL"; tokenEntitlements: null };
  costs: { estimateLamports: bigint | null; reserveLamports: bigint | null; sufficient: boolean | null };
  holdReasons: string[];
  /** Future execution ids are a separate namespace from planId; nothing here is a signature or a payment. */
  executionId: null;
};

export type Store = {
  /** Atomic CAS lease; returns true if `owner` now holds it until `until`. */
  acquireLease(owner: string, now: number, until: number): Promise<boolean>;
  releaseLease(owner: string): Promise<void>;
  /** Idempotent insert by key; false if already present. */
  putReceipt(r: Receipt): Promise<boolean>;
  receipts(): Promise<Receipt[]>;
  watermark(): Promise<number | null>; // last sealed window start
  sealedPlan(window: number): Promise<Plan | null>;
  /** Atomic: write plan + mark receipts consumed + advance watermark to plan.window + per-owner carry. Fails if watermark moved. */
  commitWindow(expectedWatermark: number | null, plan: Plan, carry: Map<string, bigint>): Promise<boolean>;
  ownerCarry(): Promise<Map<string, bigint>>;
  consumed(): Promise<Set<string>>;
};

export type IngestOutcome = { kind: "CREDITED" | "DUPLICATE" | "LATE_ADJUSTMENT" } | { kind: "REJECTED"; reason: string };

export function configBlockers(c: NativeConfig): string[] {
  const b: string[] = [];
  if (!c.mint) b.push("NATIVE_MINT_UNSET");
  if (!c.sharingConfig) b.push("SHARING_CONFIG_UNSET");
  if (!c.rewardsTreasury) b.push("REWARDS_TREASURY_UNSET");
  if (!c.operationsTreasury) b.push("OPERATIONS_TREASURY_UNSET");
  return b;
}

/** Ingest one decoded distribution. `finalized` must come from a finalized-commitment fetch, never inferred. */
export async function ingestDistribution(store: Store, cfg: NativeConfig, d: Distribution, finalized: boolean): Promise<IngestOutcome> {
  const blk = configBlockers(cfg);
  if (blk.length) return { kind: "REJECTED", reason: blk[0]! };
  if (!finalized) return { kind: "REJECTED", reason: "not_finalized" };
  if (d.blockTime === null) return { kind: "REJECTED", reason: "block_time_unknown" };
  if (d.sharingConfig !== cfg.sharingConfig) return { kind: "REJECTED", reason: "wrong_sharing_config" };
  const chk = checkNativeSplit(d, { mint: cfg.mint!, rewardsTreasury: cfg.rewardsTreasury!, operationsTreasury: cfg.operationsTreasury! });
  if (!chk.ok) return { kind: "REJECTED", reason: chk.issues[0]! };
  const s = splitRewardsReceipt(chk.rewards);
  const window = epochStart(d.blockTime);
  // Key = (signature, instruction, event) — same underlying fees seen via curve and AMM paths or two scanners collapse here.
  const r: Receipt = { key: `${d.signature}:${d.ixIndex}:${d.eventIndex}`, signature: d.signature, slot: d.slot, blockTime: d.blockTime, window,
    rewardsLamports: chk.rewards, operationsLamports: chk.operations, solBudget: s.solPayout, buybackBudget: s.buyback };
  if (!(await store.putReceipt(r))) return { kind: "DUPLICATE" };
  const wm = await store.watermark();
  return { kind: wm !== null && window <= wm ? "LATE_ADJUSTMENT" : "CREDITED" };
}

export type ProcessInput = {
  workerId: string; now: number; leaseSeconds: number;
  /** Latest finalized block time from RPC; null = RPC outage/unknown (never treated as "no fees"). */
  finalizedBlockTime: number | null;
  /** Finalized holder snapshot at the window end slot, or null when no provable holder index exists. */
  snapshot: (windowEnd: number) => Promise<EligibilitySnapshot | null>;
  /** Operational cost estimate (fees, ATA rent, wSOL wrap) and approved operations reserve, both from approved sources; null = unknown. */
  costs: (holderCount: number) => { estimateLamports: bigint | null; reserveLamports: bigint | null };
  /** First window to process when the store has no watermark. */
  genesisWindow: number;
  /** Fault injection for tests. */
  crashAt?: "after_lease" | "before_commit";
};

export type ProcessResult =
  | { kind: "LEASE_HELD" } | { kind: "NOT_DUE"; nextWindow: number } | { kind: "CHAIN_TIME_UNKNOWN" } | { kind: "RACE_LOST" }
  | { kind: "SEALED"; plan: Plan };

async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Seal at most one window per call. Windows advance strictly in order; empty windows are sealed as ZERO. */
export async function processNext(store: Store, cfg: NativeConfig, inp: ProcessInput): Promise<ProcessResult> {
  if (!(await store.acquireLease(inp.workerId, inp.now, inp.now + inp.leaseSeconds))) return { kind: "LEASE_HELD" };
  try {
    if (inp.crashAt === "after_lease") throw new Error("crash_after_lease");
    const wm = await store.watermark();
    const window = wm === null ? inp.genesisWindow : wm + EPOCH_SECONDS;
    const end = window + EPOCH_SECONDS;
    if (inp.finalizedBlockTime === null) return { kind: "CHAIN_TIME_UNKNOWN" };
    if (inp.now < end + cfg.finalityLagSeconds || inp.finalizedBlockTime < end + cfg.finalityLagSeconds) return { kind: "NOT_DUE", nextWindow: window };

    const consumed = await store.consumed();
    const all = (await store.receipts()).filter((r) => !consumed.has(r.key));
    const own = all.filter((r) => r.window === window);
    const late = all.filter((r) => r.window < window); // arrived after its window sealed → explicit adjustment here
    const rs = [...own, ...late].sort((a, b) => (a.key < b.key ? -1 : 1));
    const sum = (f: (r: Receipt) => bigint) => rs.reduce((s, r) => s + f(r), 0n);
    const rewardsTotal = sum((r) => r.rewardsLamports), operationsTotal = sum((r) => r.operationsLamports);
    const solBudget = sum((r) => r.solBudget), buybackBudget = sum((r) => r.buybackBudget);
    if (solBudget + buybackBudget !== rewardsTotal) throw new Error("conservation_violation");

    const hold: string[] = [...configBlockers(cfg), "EXECUTION_NOT_APPROVED"];
    const carryIn = await store.ownerCarry();
    const carryOut = new Map(carryIn);
    let snap: EligibilitySnapshot | null = null;
    let ent: { owner: string; lamports: bigint }[] = [], carried: { owner: string; lamports: bigint }[] = [], dust = 0n;
    let costs: Plan["costs"] = { estimateLamports: null, reserveLamports: null, sufficient: null };

    if (rs.length > 0) {
      snap = await inp.snapshot(end);
      if (!snap) hold.push("HOLDER_INDEX_UNAVAILABLE");
      else {
        if (snap.status !== "COMPLETE") hold.push(`SNAPSHOT_${snap.status}`);
        if (!snap.livePayoutAllowed) hold.push(...snap.reasons.map((r) => `SNAPSHOT:${r}`));
        if (snap.status !== "INVALID") {
          const r = holderSplit(solBudget, snap.holders, carryIn, cfg.minPayableLamports);
          ent = r.paid; carried = r.carried; dust = r.dust;
          for (const [o] of carryOut) if (r.paid.some((p) => p.owner === o)) carryOut.delete(o);
          for (const c of r.carried) carryOut.set(c.owner, c.lamports);
          const assigned = ent.reduce((s, x) => s + x.lamports, 0n) + carried.reduce((s, x) => s + x.lamports, 0n) + dust;
          const carriedInUsed = [...carryIn].filter(([o]) => snap!.holders.some((h) => h.owner === o)).reduce((s, [, v]) => s + v, 0n);
          if (assigned !== solBudget + carriedInUsed) throw new Error("holder_total_mismatch");
        }
      }
      const c = inp.costs(ent.length);
      costs = { ...c, sufficient: c.estimateLamports === null || c.reserveLamports === null ? null : c.reserveLamports >= c.estimateLamports };
      if (costs.sufficient === null) hold.push("COST_RESERVE_UNKNOWN");
      else if (!costs.sufficient) hold.push("COST_RESERVE_INSUFFICIENT");
    }

    const canonical = JSON.stringify({ window, keys: rs.map((r) => r.key), snap: snap ? [snap.slot, snap.configVersion] : null, sol: String(solBudget), bb: String(buybackBudget) });
    const plan: Plan = {
      planId: `plan_${(await sha256Hex(canonical)).slice(0, 32)}`, window, revision: 1, mode: "DRY_RUN",
      status: rs.length === 0 ? "PLANNED" : "HELD",
      receiptKeys: own.map((r) => r.key).sort(), adjustmentKeys: late.map((r) => r.key).sort(),
      rewardsTotal, operationsTotal, solBudget, buybackBudget,
      snapshotSlot: snap?.slot ?? null, snapshotConfigVersion: snap?.configVersion ?? null,
      solEntitlements: ent, solCarriedOut: carried, solDust: dust,
      buyback: { budgetLamports: buybackBudget, state: "AWAITING_EXECUTION_APPROVAL", tokenEntitlements: null },
      costs, holdReasons: [...new Set(hold)], executionId: null,
    };
    if (inp.crashAt === "before_commit") throw new Error("crash_before_commit");
    if (!(await store.commitWindow(wm, plan, carryOut))) return { kind: "RACE_LOST" };
    return { kind: "SEALED", plan };
  } finally {
    await store.releaseLease(inp.workerId);
  }
}

/** Pro-rata with per-owner carry: each owner's prior carry is added to their share; below minimum → carried for that owner. */
export function holderSplit(total: bigint, holders: readonly { owner: string; amount: bigint }[], carryIn: Map<string, bigint>, minPayable: bigint) {
  const rows = holders.filter((h) => h.amount > 0n);
  const sum = rows.reduce((s, h) => s + h.amount, 0n);
  if (sum === 0n) return { paid: [], carried: [], dust: total };
  let assigned = 0n;
  const base = rows.map((h) => { const q = (total * h.amount) / sum; assigned += q; return { owner: h.owner, q, r: (total * h.amount) % sum }; });
  let left = total - assigned;
  [...base].sort((a, b) => (a.r === b.r ? (a.owner < b.owner ? -1 : 1) : a.r > b.r ? -1 : 1)).forEach((x) => { if (left > 0n) { x.q += 1n; left -= 1n; } });
  const paid: { owner: string; lamports: bigint }[] = [], carried: { owner: string; lamports: bigint }[] = [];
  for (const x of base.sort((a, b) => (a.owner < b.owner ? -1 : 1))) {
    const v = x.q + (carryIn.get(x.owner) ?? 0n);
    if (v === 0n) continue;
    (v >= minPayable ? paid : carried).push({ owner: x.owner, lamports: v });
  }
  return { paid, carried, dust: left };
}

// ---- Plan lifecycle. Executable statuses exist for schema design only; nothing in 05-D can reach them. ----
const PLAN_NEXT: Record<PlanStatus, PlanStatus[]> = {
  PLANNED: ["HELD", "CANCELLED", "APPROVED"], HELD: ["PLANNED", "CANCELLED"], CANCELLED: [],
  APPROVED: ["SUBMITTED", "CANCELLED"], SUBMITTED: ["CONFIRMED"], CONFIRMED: ["RECONCILED"], RECONCILED: [],
};
export function transitionPlan(p: Plan, to: PlanStatus): Plan {
  if (!PLAN_NEXT[p.status].includes(to)) throw new Error(`illegal_plan_transition:${p.status}->${to}`);
  if (to === "APPROVED" || to === "SUBMITTED" || to === "CONFIRMED" || to === "RECONCILED") throw new Error("EXECUTION_NOT_APPROVED");
  return { ...p, status: to };
}

/** Future step: only a VERIFIED fill (finalized swap with exact token out) can become token entitlements. */
export function allocateFill(plan: Plan, fill: { verified: boolean; spentLamports: bigint; tokenOut: bigint } | null, holders: { owner: string; amount: bigint }[]) {
  if (!fill || !fill.verified) return { kind: "PENDING_FILL" as const };
  if (fill.spentLamports > plan.buyback.budgetLamports) return { kind: "BLOCKED" as const, reason: "fill_exceeds_budget" };
  const r = holderSplit(fill.tokenOut, holders, new Map(), 1n);
  return { kind: "DRY_RUN" as const, entitlements: r.paid, dust: r.dust };
}

/** Observation of a balance source: UNKNOWN (couldn't read) ≠ NOT_FOUND (no such record) ≠ a real value (incl. zero). */
export type Observed = { kind: "VALUE"; lamports: bigint } | { kind: "UNKNOWN"; reason: string } | { kind: "NOT_FOUND" };

/** Reconcile ledger against independently observed treasury inflows for a window. Fails closed. */
export async function reconcile(store: Store, window: number, observedRewards: Observed, observedOps: Observed) {
  const plan = await store.sealedPlan(window);
  if (!plan) return { kind: "NOT_FOUND" as const };
  const issues: string[] = [];
  for (const [name, o, want] of [["rewards", observedRewards, plan.rewardsTotal], ["operations", observedOps, plan.operationsTotal]] as const) {
    if (o.kind === "UNKNOWN") issues.push(`${name}_unknown:${o.reason}`);
    else if (o.kind === "NOT_FOUND") issues.push(`${name}_not_found`);
    else if (o.lamports < want) issues.push(`${name}_shortfall`);
    else if (o.lamports > want) issues.push(`${name}_unattributed_excess`);
  }
  const owners = new Set<string>();
  for (const e of plan.solEntitlements) { if (owners.has(e.owner)) issues.push("duplicate_owner"); owners.add(e.owner); }
  if (plan.solBudget + plan.buybackBudget !== plan.rewardsTotal) issues.push("budget_not_conserved");
  return issues.length ? { kind: "MISMATCH" as const, issues } : { kind: "RECONCILED" as const };
}

export function memoryStore() {
  let lease: { owner: string; until: number } | null = null;
  const receipts = new Map<string, Receipt>(), plans = new Map<number, Plan>(), consumed = new Set<string>();
  let wm: number | null = null, carry = new Map<string, bigint>();
  const s: Store & { plans: typeof plans } = {
    plans,
    async acquireLease(o, now, until) { if (lease && lease.until > now && lease.owner !== o) return false; lease = { owner: o, until }; return true; },
    async releaseLease(o) { if (lease?.owner === o) lease = null; },
    async putReceipt(r) { if (receipts.has(r.key)) return false; receipts.set(r.key, r); return true; },
    async receipts() { return [...receipts.values()]; },
    async watermark() { return wm; },
    async sealedPlan(w) { return plans.get(w) ?? null; },
    async commitWindow(exp, p, c) {
      if (wm !== exp || plans.has(p.window)) return false;
      plans.set(p.window, Object.freeze(p)); for (const k of [...p.receiptKeys, ...p.adjustmentKeys]) consumed.add(k);
      wm = p.window; carry = new Map(c); return true;
    },
    async ownerCarry() { return new Map(carry); },
    async consumed() { return new Set(consumed); },
  };
  return s;
}
