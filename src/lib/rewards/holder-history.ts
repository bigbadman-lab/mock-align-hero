// Historical holder snapshots (05-E). Pure reconstruction + capability-gated adapters. No invented history.
//
// Model: an ANCHOR = complete finalized token-account set for the mint at slot S (all SPL + Token-2022 accounts,
// including zero balances, with supply at S), followed by a CONTIGUOUS, gap-checked stream of per-account changes
// (create, balance, owner reassignment, delegate, freeze, close) indexed from finalized blocks S+1..T.
// State at T = anchor + changes with slot ≤ T, valid only when coverage is proven unbroken through T.
// Plain `getProgramAccounts`/`getTokenLargestAccounts` return CURRENT state only and are never a historical source.
import type { HolderAccount, SnapshotInput } from "./eligibility";

export type Anchor = { mint: string; slot: number; supply: bigint; accounts: Omit<HolderAccount, "slot">[]; source: string };
export type Change =
  | { seq: number; slot: number; kind: "CREATE"; account: string; owner: string; tokenProgram: string; ownerKind: HolderAccount["ownerKind"] }
  | { seq: number; slot: number; kind: "BALANCE"; account: string; amount: bigint }
  | { seq: number; slot: number; kind: "OWNER"; account: string; owner: string; ownerKind: HolderAccount["ownerKind"] }
  | { seq: number; slot: number; kind: "DELEGATE"; account: string; delegated: boolean }
  | { seq: number; slot: number; kind: "FREEZE"; account: string; frozen: boolean }
  | { seq: number; slot: number; kind: "CLOSE"; account: string }
  | { seq: number; slot: number; kind: "SUPPLY"; supply: bigint };

/** Indexer coverage: every finalized slot in [fromSlot, toSlot] was processed; `skipped` lists slots with no block (leader skip), proven by RPC. */
export type Coverage = { fromSlot: number; toSlot: number; lastSeq: number };

export type Reconstructed = { kind: "OK"; input: SnapshotInput } | { kind: "BLOCKED"; reason: string };

export function reconstructAt(anchor: Anchor | null, changes: readonly Change[], coverage: Coverage | null, slot: number): Reconstructed {
  if (!anchor) return { kind: "BLOCKED", reason: "no_anchor_snapshot" };
  if (slot < anchor.slot) return { kind: "BLOCKED", reason: "slot_before_anchor" };
  if (!coverage || coverage.fromSlot !== anchor.slot + 1 && slot > anchor.slot) return { kind: "BLOCKED", reason: "coverage_not_contiguous_with_anchor" };
  if (slot > anchor.slot && coverage.toSlot < slot) return { kind: "BLOCKED", reason: "coverage_gap_before_target_slot" };
  const sorted = [...changes].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.seq !== i + 1) return { kind: "BLOCKED", reason: "change_sequence_gap" };
    if (i && sorted[i]!.slot < sorted[i - 1]!.slot) return { kind: "BLOCKED", reason: "change_slot_regression" };
    if (sorted[i]!.slot <= anchor.slot) return { kind: "BLOCKED", reason: "change_before_anchor" };
  }
  if (sorted.length && coverage && sorted[sorted.length - 1]!.seq !== coverage.lastSeq) return { kind: "BLOCKED", reason: "coverage_seq_mismatch" };

  type Acc = Omit<HolderAccount, "slot"> & { open: boolean };
  const m = new Map<string, Acc>();
  for (const a of anchor.accounts) {
    if (a.mint !== anchor.mint) return { kind: "BLOCKED", reason: "anchor_foreign_mint" };
    if (m.has(a.account)) return { kind: "BLOCKED", reason: "anchor_duplicate_account" };
    m.set(a.account, { ...a, open: true });
  }
  let supply = anchor.supply;
  for (const c of sorted) {
    if (c.slot > slot) break;
    if (c.kind === "SUPPLY") { supply = c.supply; continue; }
    const a = m.get(c.account);
    if (c.kind === "CREATE") {
      if (a?.open) return { kind: "BLOCKED", reason: "create_existing_account" };
      m.set(c.account, { account: c.account, mint: anchor.mint, tokenProgram: c.tokenProgram, owner: c.owner, ownerKind: c.ownerKind, amount: 0n, open: true });
      continue;
    }
    if (!a || !a.open) return { kind: "BLOCKED", reason: "change_for_unknown_account" };
    if (c.kind === "BALANCE") { if (c.amount < 0n) return { kind: "BLOCKED", reason: "negative_balance" }; a.amount = c.amount; }
    else if (c.kind === "OWNER") { a.owner = c.owner; a.ownerKind = c.ownerKind; }
    else if (c.kind === "DELEGATE") a.delegated = c.delegated;
    else if (c.kind === "FREEZE") a.frozen = c.frozen;
    else if (c.kind === "CLOSE") { if (a.amount !== 0n) return { kind: "BLOCKED", reason: "close_with_balance" }; a.open = false; }
  }
  const accounts = [...m.values()].filter((a) => a.open).map(({ open: _o, ...a }) => ({ ...a, slot }));
  const total = accounts.reduce((s, a) => s + a.amount, 0n);
  if (total !== supply) return { kind: "BLOCKED", reason: "reconstructed_balances_do_not_reconcile_to_supply" };
  return { kind: "OK", input: { mint: anchor.mint, slot, commitment: "finalized", totalSupply: supply, accounts, source: `${anchor.source}+index`, capturedForEpochAt: "CURRENT" } };
}

/** Capability-gated source. Production has NO archival/indexed provider configured → BLOCKED, never "current balances". */
export type HolderHistorySource = { capability: "NONE" | "ANCHOR_PLUS_INDEX"; snapshotAt(slot: number): Promise<Reconstructed> };
export const unavailableHistory: HolderHistorySource = {
  capability: "NONE",
  async snapshotAt() { return { kind: "BLOCKED", reason: "historical_holder_source_not_configured" }; },
};
