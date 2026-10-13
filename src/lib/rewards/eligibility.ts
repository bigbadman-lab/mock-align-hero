// Holder eligibility v1 (locked by Phase 05-B brief). Pure.
// - Eligible: verified owners of a positive canonical $MCP balance at one finalized slot. Minimum = > 0, no threshold.
// - Multiple token accounts of the same owner (SPL Token and Token-2022) are aggregated.
// - Excluded from weighting: listed pool vaults, burn/incinerator, and MCPX treasury/reserve addresses from a
//   versioned exclusion config. Without an approved config, live payouts are BLOCKED.
// - Program-owned / delegated / unknown-authority holdings are NOT blanket-excluded: they are flagged AMBIGUOUS
//   for explicit review and block live payouts until resolved.
// - The snapshot must reconcile to total supply; otherwise it is INCOMPLETE. Current balances are never used for past epochs.
import { proRata } from "./economics";

export const TOKEN_PROGRAMS = { spl: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" } as const;
export const BURN_ADDRESSES = ["1nc1nerator11111111111111111111111111111111"] as const;

export type ExclusionConfig = { version: string; approved: boolean; poolVaults: string[]; treasuries: string[]; reserves: string[]; deployer?: string[]; extraBurn?: string[]; resolvedOwners: Record<string, "ELIGIBLE" | "EXCLUDED"> };

export type HolderAccount = {
  account: string; mint: string; tokenProgram: string; owner: string; amount: bigint; slot: number;
  /** "WALLET" = owner is an on-curve system account; "PROGRAM" = owner is a PDA/program; "UNKNOWN" = not verified. */
  ownerKind: "WALLET" | "PROGRAM" | "UNKNOWN";
  delegated?: boolean; frozen?: boolean;
};

export type SnapshotInput = { mint: string; slot: number; commitment: string; totalSupply: bigint | null; accounts: HolderAccount[]; source: string; capturedForEpochAt?: "CURRENT" | "HISTORICAL" };

export type EligibilitySnapshot = {
  status: "COMPLETE" | "INCOMPLETE" | "INVALID";
  reasons: string[];
  mint: string; slot: number; source: string; configVersion: string;
  holders: { owner: string; amount: bigint }[];
  excluded: { owner: string; amount: bigint; why: string }[];
  ambiguous: { owner: string; amount: bigint; why: string }[];
  eligibleTotal: bigint; excludedTotal: bigint; ambiguousTotal: bigint;
  livePayoutAllowed: boolean;
};

export function buildEligibility(input: SnapshotInput, cfg: ExclusionConfig): EligibilitySnapshot {
  const reasons: string[] = [];
  const base = { mint: input.mint, slot: input.slot, source: input.source, configVersion: cfg.version };
  const invalid = (r: string): EligibilitySnapshot => ({ ...base, status: "INVALID", reasons: [r], holders: [], excluded: [], ambiguous: [], eligibleTotal: 0n, excludedTotal: 0n, ambiguousTotal: 0n, livePayoutAllowed: false });
  if (input.capturedForEpochAt === "HISTORICAL") return invalid("historical_snapshot_unavailable_no_point_in_time_source");
  if (input.commitment !== "finalized") return invalid("snapshot_not_finalized");
  const seen = new Set<string>();
  for (const a of input.accounts) {
    if (a.mint !== input.mint) return invalid("foreign_mint_account");
    if (a.slot !== input.slot) return invalid("mixed_slots");
    if (a.tokenProgram !== TOKEN_PROGRAMS.spl && a.tokenProgram !== TOKEN_PROGRAMS.token2022) return invalid("unknown_token_program");
    if (a.amount < 0n) return invalid("negative_balance");
    if (seen.has(a.account)) return invalid("duplicate_account");
    seen.add(a.account);
  }
  const excludedSet = new Map<string, string>();
  for (const x of cfg.poolVaults) excludedSet.set(x, "pool_vault");
  for (const x of cfg.treasuries) excludedSet.set(x, "mcpx_treasury");
  for (const x of cfg.reserves) excludedSet.set(x, "mcpx_reserve");
  for (const x of BURN_ADDRESSES) excludedSet.set(x, "burn");
  for (const x of cfg.extraBurn ?? []) excludedSet.set(x, "burn");
  for (const x of cfg.deployer ?? []) excludedSet.set(x, "native_deployer");

  const sum = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  const elig = new Map<string, bigint>(), excl = new Map<string, bigint>(), amb = new Map<string, bigint>();
  const exclWhy = new Map<string, string>(), ambWhy = new Map<string, string>();
  for (const a of input.accounts) {
    if (a.amount === 0n) continue;
    const resolved = cfg.resolvedOwners[a.owner];
    const why = excludedSet.get(a.owner) ?? excludedSet.get(a.account);
    if (why || resolved === "EXCLUDED") { sum(excl, a.owner, a.amount); exclWhy.set(a.owner, why ?? "reviewed_excluded"); continue; }
    if (resolved !== "ELIGIBLE" && (a.ownerKind !== "WALLET" || a.delegated || a.frozen)) {
      sum(amb, a.owner, a.amount); ambWhy.set(a.owner, a.ownerKind !== "WALLET" ? `owner_${a.ownerKind.toLowerCase()}` : a.delegated ? "delegated" : "frozen"); continue;
    }
    sum(elig, a.owner, a.amount);
  }
  const list = (m: Map<string, bigint>) => [...m].map(([owner, amount]) => ({ owner, amount })).sort((x, y) => (x.owner < y.owner ? -1 : 1));
  const tot = (m: Map<string, bigint>) => [...m.values()].reduce((s, v) => s + v, 0n);
  const eligibleTotal = tot(elig), excludedTotal = tot(excl), ambiguousTotal = tot(amb);
  if (input.totalSupply === null) reasons.push("total_supply_unknown");
  else if (eligibleTotal + excludedTotal + ambiguousTotal !== input.totalSupply) reasons.push("supply_not_reconciled");
  const status = reasons.length ? "INCOMPLETE" : "COMPLETE";
  const live = status === "COMPLETE" && cfg.approved && amb.size === 0;
  if (!cfg.approved) reasons.push("exclusion_config_not_approved");
  if (amb.size) reasons.push("ambiguous_holdings_need_review");
  return { ...base, status, reasons, holders: list(elig), excluded: list(excl).map((h) => ({ ...h, why: exclWhy.get(h.owner)! })), ambiguous: list(amb).map((h) => ({ ...h, why: ambWhy.get(h.owner)! })), eligibleTotal, excludedTotal, ambiguousTotal, livePayoutAllowed: live };
}

/** Pro-rata for one branch. Live amounts only when allowed; otherwise a clearly labelled dry run, or BLOCKED. */
export function branchEntitlements(snap: EligibilitySnapshot, total: bigint, mode: "LIVE" | "DRY_RUN", minPayable = 1n) {
  if (snap.status === "INVALID") return { kind: "BLOCKED" as const, reasons: snap.reasons };
  if (mode === "LIVE" && !snap.livePayoutAllowed) return { kind: "BLOCKED" as const, reasons: snap.reasons };
  const { shares, dust } = proRata(total, snap.holders, minPayable);
  return { kind: mode, shares, carry: dust } as const;
}
