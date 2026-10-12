// Draft and future on-chain lifecycle (Phase 04-E). Off-chain draft states and on-chain attempt states
// are separate. In this phase every draft's chain status is NOT_STARTED (enforced by a database CHECK),
// and nothing writes creation attempts. The attempt contract below exists so a later phase cannot
// invent progress: the database trigger mcpx_attempt_guard enforces the same rules.
//
//   Draft:   DRAFT ──artwork──▶ ARTWORK_SAVED ──metadata──▶ READY_FOR_FUTURE_PREPARATION
//              ▲  any edit / new artwork resets to DRAFT or ARTWORK_SAVED (old metadata never reused)
//              └─ ABANDONED (terminal; reachable from every state)
//   READY_FOR_FUTURE_PREPARATION means only "off-chain validation passed". It is not created/launched/owned.
//   METADATA_VALIDATED is reserved (kept in the schema) and not used: metadata is only stored after it validates.
//
//   Attempt: PREPARED_UNSIGNED → AWAITING_SIGNATURES → SUBMITTED → CONFIRMED → FEE_VERIFIED | FEE_MISMATCH
//            PREPARED_UNSIGNED/AWAITING_SIGNATURES → EXPIRED (blockhash passed, nothing sent)
//            SUBMITTED → UNKNOWN_OUTCOME (RPC can't tell) → recovery checks the SAME mint; never a new one
//            any → FAILED (only with evidence)
export const DRAFT_STATES = ["DRAFT", "ARTWORK_SAVED", "METADATA_VALIDATED", "READY_FOR_FUTURE_PREPARATION", "ABANDONED"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];
export const CHAIN_STATUS_NOW = "NOT_STARTED" as const;

export const ATTEMPT_STATES = ["PREPARED_UNSIGNED", "AWAITING_SIGNATURES", "SUBMITTED", "CONFIRMED", "FEE_VERIFIED", "FAILED", "EXPIRED", "UNKNOWN_OUTCOME", "FEE_MISMATCH"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

const NEXT: Record<AttemptState, AttemptState[]> = {
  PREPARED_UNSIGNED: ["AWAITING_SIGNATURES", "EXPIRED", "FAILED"],
  AWAITING_SIGNATURES: ["SUBMITTED", "EXPIRED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "UNKNOWN_OUTCOME", "FAILED"],
  UNKNOWN_OUTCOME: ["CONFIRMED", "FAILED", "UNKNOWN_OUTCOME"],
  CONFIRMED: ["FEE_VERIFIED", "FEE_MISMATCH"],
  FEE_VERIFIED: [], FEE_MISMATCH: [], FAILED: [], EXPIRED: [],
};

export interface AttemptEvidence { signature?: string; mint?: string; chainProof?: unknown }

/** Allowed only with the evidence each state needs. Builder "UNKNOWN" maps to UNKNOWN_OUTCOME, never "not found". */
export function canTransition(from: AttemptState, to: AttemptState, ev: AttemptEvidence): boolean {
  if (!NEXT[from].includes(to)) return false;
  if (["SUBMITTED", "CONFIRMED", "FEE_VERIFIED", "FEE_MISMATCH", "UNKNOWN_OUTCOME"].includes(to) && (!ev.signature || !ev.mint)) return false;
  if (["CONFIRMED", "FEE_VERIFIED", "FEE_MISMATCH"].includes(to) && ev.chainProof == null) return false;
  return true;
}

/** Retrying after an uncertain outcome must reuse the original mint. */
export function recoveryMint(prev: { state: AttemptState; mint: string | null }): { reuse: string } | { fresh: true } | { blocked: true } {
  if (prev.mint && ["SUBMITTED", "UNKNOWN_OUTCOME", "CONFIRMED", "FEE_MISMATCH", "FEE_VERIFIED"].includes(prev.state)) return { reuse: prev.mint };
  if (prev.state === "EXPIRED" || prev.state === "FAILED") return prev.mint ? { reuse: prev.mint } : { fresh: true };
  return { blocked: true };
}

/** The draft status after any edit: metadata is always dropped. */
export const statusAfterEdit = (hasArtwork: boolean): DraftState => (hasArtwork ? "ARTWORK_SAVED" : "DRAFT");
