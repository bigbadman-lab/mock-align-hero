// Five-minute UTC-aligned reward epochs and their state machine. Pure; persistence enforces the same rules in SQL.
export const EPOCH_SECONDS = 300;

export type EpochState = "OPEN" | "FUNDED" | "SNAPSHOT_READY" | "EXECUTION_PENDING" | "SETTLED" | "HELD" | "FAILED_RETRYABLE" | "CARRIED_FORWARD";

const NEXT: Record<EpochState, readonly EpochState[]> = {
  OPEN: ["FUNDED", "CARRIED_FORWARD", "HELD"],
  FUNDED: ["SNAPSHOT_READY", "HELD", "FAILED_RETRYABLE"],
  SNAPSHOT_READY: ["EXECUTION_PENDING", "HELD", "FAILED_RETRYABLE"],
  EXECUTION_PENDING: ["SETTLED", "HELD", "FAILED_RETRYABLE"],
  FAILED_RETRYABLE: ["FUNDED", "SNAPSHOT_READY", "HELD"],
  HELD: ["FUNDED", "SNAPSHOT_READY", "FAILED_RETRYABLE"],
  SETTLED: [],
  CARRIED_FORWARD: [],
};

export const canTransition = (from: EpochState, to: EpochState) => NEXT[from].includes(to);

/** Epoch id = window start in unix seconds; [start, start+300). A timestamp exactly on a boundary belongs to the new epoch. */
export function epochStart(unixSeconds: number): number {
  if (!Number.isFinite(unixSeconds) || unixSeconds < 0) throw new Error("bad_time");
  return Math.floor(unixSeconds / EPOCH_SECONDS) * EPOCH_SECONDS;
}

/** An epoch may only close once its window has fully ended AND the chain's finalized block time has passed the end. */
export function canClose(start: number, nowSeconds: number, finalizedBlockTime: number | null): boolean {
  if (finalizedBlockTime === null) return false; // unknown chain time ≠ closed
  const end = start + EPOCH_SECONDS;
  return nowSeconds >= end && finalizedBlockTime >= end;
}
