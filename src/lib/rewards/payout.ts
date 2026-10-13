// 05-F payout contracts — batching, identity, lifecycle and recovery protocol. NO EXECUTION: nothing here can sign or send,
// and the only reachable states are PLANNED (+ UNKNOWN/FAILED for modelling). Executed records are never created.
export type Asset = "SOL" | "MCP";
export type Recipient = { owner: string; amount: bigint; ata: { exists: boolean; frozen: boolean; program: "SPL" | "T22" | "SYSTEM" } };

export const STATES = ["PLANNED", "AUTHORIZED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FINALIZED", "RECONCILED", "UNKNOWN", "FAILED"] as const;
export type BatchState = (typeof STATES)[number];

/** Evidence each future transition needs. 05-F implements none of the executable ones. */
export const EVIDENCE: Record<Exclude<BatchState, "PLANNED">, string> = {
  AUTHORIZED: "approved treasury config digest + budget version + operator approval record (≥2 approvers)",
  PREPARED: "unsigned message bytes + recent blockhash + lastValidBlockHeight, durably stored BEFORE any signing",
  SIGNED: "signature derived from stored message (signature = tx id), durably stored BEFORE broadcast",
  SUBMITTED: "sendTransaction ack for that exact signature",
  CONFIRMED: "getSignatureStatuses confirmed, err=null",
  FINALIZED: "finalized status + per-recipient balance deltas equal intended amounts",
  RECONCILED: "ledger obligations closed, treasury delta = sum(amounts) + fees from Operations",
  UNKNOWN: "submitted signature not found before lastValidBlockHeight check completes",
  FAILED: "finalized err≠null OR blockhash expired (block height > lastValidBlockHeight) with signature never landed",
};

const NEXT: Record<BatchState, BatchState[]> = {
  PLANNED: ["AUTHORIZED", "FAILED"], AUTHORIZED: ["PREPARED"], PREPARED: ["SIGNED", "FAILED"], SIGNED: ["SUBMITTED", "UNKNOWN"],
  SUBMITTED: ["CONFIRMED", "UNKNOWN", "FAILED"], CONFIRMED: ["FINALIZED", "UNKNOWN"], FINALIZED: ["RECONCILED"], RECONCILED: [],
  UNKNOWN: ["CONFIRMED", "FAILED"], FAILED: [],
};
const EXECUTABLE = new Set<BatchState>(["AUTHORIZED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FINALIZED", "RECONCILED"]);
export function transition(from: BatchState, to: BatchState): BatchState {
  if (!NEXT[from].includes(to)) throw new Error(`illegal_batch_transition:${from}->${to}`);
  if (EXECUTABLE.has(to)) throw new Error("EXECUTION_NOT_APPROVED");
  return to;
}

/**
 * Replacement rule (prevents onchain double pay): a batch in SIGNED/SUBMITTED/UNKNOWN may be replaced ONLY when the stored
 * signature is absent from chain AND the current finalized block height exceeds its stored lastValidBlockHeight.
 * Otherwise the batch stays UNKNOWN and blocks the window.
 */
export function canReplace(b: { state: BatchState; signature: string | null; lastValidBlockHeight: number | null },
  chain: { signatureFound: boolean | null; finalizedBlockHeight: number | null }) {
  if (b.state === "PLANNED" || b.state === "AUTHORIZED" || b.state === "PREPARED") return b.signature === null; // never signed → safe
  if (b.signature === null || b.lastValidBlockHeight === null) return false;   // signed but evidence missing → unsafe
  if (chain.signatureFound !== false || chain.finalizedBlockHeight === null) return false; // found or unknown → unsafe
  return chain.finalizedBlockHeight > b.lastValidBlockHeight;
}

export type BatchLimits = { maxRecipients: number; rentPerAtaLamports: bigint; feePerTxLamports: bigint };
export type Batch = { batchId: string; asset: Asset; window: number; budgetVersion: string; mint: string | null; recipients: { owner: string; amount: bigint; createsAta: boolean }[]; total: bigint; opsCost: bigint; state: "PLANNED" };

async function sha(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }

/** Deterministic batching. Frozen/unsupported recipients are HELD (amount carried for that owner), never silently dropped. */
export async function planBatches(asset: Asset, window: number, budgetVersion: string, mint: string | null, rs: readonly Recipient[], l: BatchLimits) {
  if (l.maxRecipients < 1 || l.maxRecipients > 20) throw new Error("max_recipients_out_of_range");
  const seen = new Set<string>();
  for (const r of rs) { if (seen.has(r.owner)) throw new Error("duplicate_owner"); seen.add(r.owner); if (r.amount <= 0n) throw new Error("non_positive_amount"); }
  if (asset === "MCP" && !mint) throw new Error("mint_required");
  const held: { owner: string; amount: bigint; reason: string }[] = [], ok: Recipient[] = [];
  for (const r of [...rs].sort((a, b) => (a.owner < b.owner ? -1 : 1))) {
    if (asset === "MCP" && r.ata.frozen) held.push({ owner: r.owner, amount: r.amount, reason: "RECIPIENT_ACCOUNT_FROZEN" });
    else if (asset === "MCP" && r.ata.program === "SYSTEM") held.push({ owner: r.owner, amount: r.amount, reason: "UNSUPPORTED_ACCOUNT_STATE" });
    else ok.push(r);
  }
  const batches: Batch[] = [];
  for (let i = 0; i < ok.length; i += l.maxRecipients) {
    const part = ok.slice(i, i + l.maxRecipients);
    const recipients = part.map((r) => ({ owner: r.owner, amount: r.amount, createsAta: asset === "MCP" && !r.ata.exists }));
    const total = recipients.reduce((s, r) => s + r.amount, 0n);
    const opsCost = l.feePerTxLamports + l.rentPerAtaLamports * BigInt(recipients.filter((r) => r.createsAta).length);
    const id = await sha(JSON.stringify({ asset, window, budgetVersion, mint, recipients: recipients.map((r) => [r.owner, String(r.amount)]) }));
    batches.push({ batchId: `pb_${id.slice(0, 32)}`, asset, window, budgetVersion, mint, recipients, total, opsCost, state: "PLANNED" });
  }
  return { batches, held, total: batches.reduce((s, b) => s + b.total, 0n), heldTotal: held.reduce((s, h) => s + h.amount, 0n), opsCost: batches.reduce((s, b) => s + b.opsCost, 0n) };
}

/** Native ledger invariant (F05.3). Every term is observed or recorded — plans never count as settled. */
export function nativeInvariant(x: {
  observedRewardsReceipts: bigint; observedOperationsReceipts: bigint;
  solBudget: bigint; buybackBudget: bigint;
  settledSol: bigint; unsettledSol: bigint; solCarry: bigint;
  buybackSpent: bigint; buybackUnspent: bigint;
  rewardsTreasuryBalanceDelta: bigint | null;
}) {
  const issues: string[] = [];
  if (x.solBudget + x.buybackBudget !== x.observedRewardsReceipts) issues.push("BUDGET_NOT_EQUAL_RECEIPTS");
  if (x.settledSol + x.unsettledSol + x.solCarry !== x.solBudget) issues.push("SOL_OBLIGATIONS_NOT_CONSERVED");
  if (x.buybackSpent + x.buybackUnspent !== x.buybackBudget) issues.push("BUYBACK_NOT_CONSERVED");
  for (const [k, v] of Object.entries(x)) if (typeof v === "bigint" && v < 0n) issues.push(`NEGATIVE:${k}`);
  if (x.rewardsTreasuryBalanceDelta === null) issues.push("TREASURY_BALANCE_UNKNOWN");
  else if (x.rewardsTreasuryBalanceDelta !== x.observedRewardsReceipts - x.settledSol - x.buybackSpent) issues.push("TREASURY_BALANCE_MISMATCH");
  return issues.length ? { ok: false as const, issues } : { ok: true as const };
}
