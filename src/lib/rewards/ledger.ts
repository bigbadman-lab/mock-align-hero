// Fee ingest + allocation ledger core with an injectable store (production: Postgres via service role; tests: memory).
// Rules: an event is identified by (signature, instruction index, event index); only FINALIZED events from the expected
// program/mint/recipient/asset are credited; uncertain sources are quarantined, never credited and never treated as zero.
import { allocate, type Allocation } from "./economics";
import { canTransition, epochStart, type EpochState } from "./epochs";

export const NATIVE_FEE_SOURCES = ["PUMP_CURVE_COLLECT_V2", "PUMP_AMM_COLLECT_COIN_CREATOR", "PUMP_FEES_DISTRIBUTE_V2"] as const;
export type FeeSource = (typeof NATIVE_FEE_SOURCES)[number];

export type ObservedFeeEvent = {
  signature: string; ixIndex: number; eventIndex: number;
  source: FeeSource; programId: string; mint: string; recipient: string; asset: string;
  amount: bigint; slot: number; blockTime: number; commitment: "processed" | "confirmed" | "finalized";
};

export type Expected = { programs: Record<FeeSource, string>; mint: string; recipient: string; asset: string };

export type IngestResult =
  | { kind: "CREDITED"; allocation: Allocation; epoch: number }
  | { kind: "DUPLICATE" }
  | { kind: "QUARANTINED"; reason: string }
  | { kind: "PENDING_FINALITY" };

export type Store = {
  hasEvent(key: string): Promise<boolean>;
  /** Atomic: record event + receipt + allocation + new carry, or nothing. Returns false if key already existed (race). */
  commitCredit(key: string, ev: ObservedFeeEvent, alloc: Allocation, epoch: number): Promise<boolean>;
  quarantine(key: string, ev: ObservedFeeEvent, reason: string): Promise<void>;
  carry(): Promise<bigint>;
};

export const eventKey = (e: Pick<ObservedFeeEvent, "signature" | "ixIndex" | "eventIndex">) => `${e.signature}:${e.ixIndex}:${e.eventIndex}`;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export async function ingest(store: Store, ev: ObservedFeeEvent, exp: Expected): Promise<IngestResult> {
  if (!SIG_RE.test(ev.signature) || !Number.isInteger(ev.ixIndex) || ev.ixIndex < 0 || !Number.isInteger(ev.eventIndex) || ev.eventIndex < 0) return { kind: "QUARANTINED", reason: "malformed_identity" };
  const key = eventKey(ev);
  if (await store.hasEvent(key)) return { kind: "DUPLICATE" };
  if (ev.commitment !== "finalized") return { kind: "PENDING_FINALITY" };
  const reason =
    exp.programs[ev.source] !== ev.programId ? "unexpected_program" :
    ev.mint !== exp.mint ? "unexpected_mint" :
    ev.recipient !== exp.recipient ? "unexpected_recipient" :
    ev.asset !== exp.asset ? "unexpected_fee_asset" :
    ev.amount <= 0n ? "non_positive_amount" : null;
  if (reason) { await store.quarantine(key, ev, reason); return { kind: "QUARANTINED", reason }; }
  const alloc = allocate(ev.amount, await store.carry());
  const epoch = epochStart(ev.blockTime);
  if (!(await store.commitCredit(key, ev, alloc, epoch))) return { kind: "DUPLICATE" };
  return { kind: "CREDITED", allocation: alloc, epoch };
}

/** Cursor scan outcome. An RPC failure is UNKNOWN — never "no fees". */
export type ScanResult = { kind: "OK"; events: ObservedFeeEvent[]; newCursor: string | null } | { kind: "UNKNOWN"; reason: string };

export function transition(from: EpochState, to: EpochState): EpochState {
  if (!canTransition(from, to)) throw new Error(`illegal_epoch_transition:${from}->${to}`);
  return to;
}

export function memoryStore() {
  const events = new Map<string, { status: "CREDITED" | "QUARANTINED"; alloc?: Allocation; epoch?: number }>();
  let carry = 0n;
  const s: Store & { events: typeof events; failNextCommit?: boolean } = {
    events,
    async hasEvent(k) { return events.has(k); },
    async commitCredit(k, _e, a, epoch) {
      if (s.failNextCommit) { s.failNextCommit = false; throw new Error("crash_before_commit"); }
      if (events.has(k)) return false;
      events.set(k, { status: "CREDITED", alloc: a, epoch }); carry = a.residualOut; return true;
    },
    async quarantine(k) { if (!events.has(k)) events.set(k, { status: "QUARANTINED" }); },
    async carry() { return carry; },
  };
  return s;
}
