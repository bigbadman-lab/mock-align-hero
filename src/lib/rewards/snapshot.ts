// Holder snapshot: aggregate token ACCOUNTS into unique OWNERS at one slot, apply exclusions, then pro-rata.
// Eligibility policy (minimum balance, which custody to exclude) is PROPOSED, not approved — see docs/REWARDS_05A.md.
import { proRata } from "./economics";

export type TokenAccountRow = { account: string; owner: string; amount: bigint; slot: number; ownerIsPda?: boolean };
export type ExclusionPolicy = { excludedOwners: ReadonlySet<string>; excludePdaOwners: boolean; minBalance: bigint; approved: boolean };

export type Snapshot =
  | { kind: "OK"; slot: number; holders: { owner: string; amount: bigint }[]; excludedAmount: bigint; policyApproved: boolean }
  | { kind: "INCONSISTENT"; reason: string };

export function buildSnapshot(rows: readonly TokenAccountRow[], policy: ExclusionPolicy): Snapshot {
  if (rows.length === 0) return { kind: "INCONSISTENT", reason: "no_rows" }; // an empty read is not "zero holders"
  const slots = new Set(rows.map((r) => r.slot));
  if (slots.size !== 1) return { kind: "INCONSISTENT", reason: "mixed_slots" };
  const seen = new Set<string>();
  const byOwner = new Map<string, bigint>();
  let excluded = 0n;
  for (const r of rows) {
    if (seen.has(r.account)) return { kind: "INCONSISTENT", reason: "duplicate_account" };
    seen.add(r.account);
    if (r.amount < 0n) return { kind: "INCONSISTENT", reason: "negative_balance" };
    if (policy.excludedOwners.has(r.owner) || (policy.excludePdaOwners && r.ownerIsPda)) { excluded += r.amount; continue; }
    byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0n) + r.amount);
  }
  const holders = [...byOwner].filter(([, a]) => a >= policy.minBalance && a > 0n).map(([owner, amount]) => ({ owner, amount })).sort((a, b) => (a.owner < b.owner ? -1 : 1));
  return { kind: "OK", slot: [...slots][0]!, holders, excludedAmount: excluded, policyApproved: policy.approved };
}

/** Entitlements for one branch (SOL lamports or acquired $MCP base units). Refuses to compute under an unapproved policy unless asked for a dry run. */
export function entitlements(snap: Snapshot, total: bigint, opts: { dryRun: boolean; minUnit?: bigint }) {
  if (snap.kind !== "OK") return { kind: "BLOCKED" as const, reason: snap.reason };
  if (!snap.policyApproved && !opts.dryRun) return { kind: "BLOCKED" as const, reason: "eligibility_policy_not_approved" };
  const { shares, dust } = proRata(total, snap.holders, opts.minUnit ?? 1n);
  return { kind: "OK" as const, shares, dust };
}
