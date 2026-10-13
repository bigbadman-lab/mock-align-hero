// 05-F treasury authority & limits — versioned, UNAPPROVED configuration schema + validator. Pure; no secrets, no addresses.
// Default state is non-executable. Approval of a real config is a future operator act outside this code.
export const ROLES = [
  "REWARDS_TREASURY",      // 60% fee-sharing recipient (custody only)
  "OPERATIONS_TREASURY",   // 40% fee-sharing recipient; funds fees/rent for all rewards execution
  "SOL_PAYOUT_AUTHORITY",  // signs holder SOL batches, funded per window from Rewards Treasury
  "BUYBACK_AUTHORITY",     // signs swaps of the approved buyback budget
  "MCP_CUSTODY",           // holds acquired $MCP until distributed
  "MCP_DISTRIBUTOR",       // signs $MCP distribution batches
  "LAUNCH_AUTHORITY",      // one-time native mint/launch signer; retired after launch
  "EMERGENCY_ADMIN",       // offline; pause/rotate only, never routine signing
] as const;
export type Role = (typeof ROLES)[number];

/** What actually enforces each control. Only ONCHAIN rows hold even if the worker is compromised. */
export const ENFORCEMENT = {
  feeSplit6040: "ONCHAIN",               // Pump fee-sharing config (if made immutable at launch)
  multisigApproval: "ONCHAIN_IF_MULTISIG", // e.g. Squads-style program; a plain wallet (Phantom) cannot
  spendCapsPerTx: "WORKER_POLICY",        // a normal keypair cannot cap its own spending
  spendCapsPerWindowDay: "WORKER_POLICY",
  destinationAllowlist: "WORKER_POLICY",
  programMintAllowlist: "WORKER_POLICY",
  pause: "WORKER_POLICY",                 // plus key removal from the worker as the real stop
  limitedHotBalance: "OPERATIONAL",       // per-window top-up so a stolen hot key loses at most one window
} as const;

export type Limits = { perTxLamports: bigint; perWindowLamports: bigint; perDayLamports: bigint; perTxTokenUnits: bigint; maxRecipientsPerBatch: number };
export type TreasuryConfig = {
  version: string; schema: 1;
  addresses: Partial<Record<Role, string>>;
  /** Each pair of roles sharing one address must be listed here with a risk note and approver. */
  sharedRoleWaivers: { roles: [Role, Role]; reason: string; approvedBy: string }[];
  limits: Limits | null;
  allowlist: { programs: string[]; mints: string[] };
  signing: { mode: "NONE" | "MULTISIG_PROPOSAL" | "HOT_KEY_CAPPED"; threshold?: number; signers?: number };
  reserves: { operationsMinLamports: bigint | null };
  expiresAt: string | null;
  paused: boolean;
  approval: null | { by: string[]; at: string; digest: string };
};

export const DEFAULT_CONFIG: TreasuryConfig = {
  version: "unapproved-0", schema: 1, addresses: {}, sharedRoleWaivers: [], limits: null,
  allowlist: { programs: [], mints: [] }, signing: { mode: "NONE" }, reserves: { operationsMinLamports: null }, expiresAt: null, paused: true, approval: null,
};

export type TreasuryBlocker =
  | `ROLE_UNSET:${Role}` | `ROLE_ADDRESS_SHARED_WITHOUT_WAIVER:${Role}+${Role}` | "INVALID_ADDRESS" | "LIMITS_UNSET" | "LIMITS_INCONSISTENT"
  | "ALLOWLIST_EMPTY" | "SIGNING_NOT_CONFIGURED" | "HOT_KEY_FORBIDDEN_FOR_TREASURIES" | "MULTISIG_THRESHOLD_INVALID" | "RESERVE_UNSET"
  | "CONFIG_EXPIRED" | "CONFIG_EXPIRY_UNSET" | "PAUSED" | "NOT_APPROVED" | "CHILD_WALLET_REUSE" | "EXECUTION_NOT_IMPLEMENTED";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Validate a config. Always returns executable:false in 05-F — EXECUTION_NOT_IMPLEMENTED is unconditional. */
export function validateTreasury(c: TreasuryConfig, ctx: { now: Date; childFeeWallets: readonly string[] }) {
  const b: TreasuryBlocker[] = [];
  for (const r of ROLES) { const a = c.addresses[r]; if (!a) b.push(`ROLE_UNSET:${r}`); else if (!B58.test(a)) b.push("INVALID_ADDRESS"); }
  const byAddr = new Map<string, Role[]>();
  for (const r of ROLES) { const a = c.addresses[r]; if (a) byAddr.set(a, [...(byAddr.get(a) ?? []), r]); }
  for (const rs of byAddr.values()) for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const ok = c.sharedRoleWaivers.some((w) => w.roles.includes(rs[i]!) && w.roles.includes(rs[j]!) && w.reason.length >= 20 && w.approvedBy);
    if (!ok) b.push(`ROLE_ADDRESS_SHARED_WITHOUT_WAIVER:${rs[i]!}+${rs[j]!}`);
  }
  if (Object.values(c.addresses).some((a) => a && ctx.childFeeWallets.includes(a))) b.push("CHILD_WALLET_REUSE");
  if (!c.limits) b.push("LIMITS_UNSET");
  else {
    const l = c.limits;
    if (l.perTxLamports <= 0n || l.perWindowLamports < l.perTxLamports || l.perDayLamports < l.perWindowLamports || l.maxRecipientsPerBatch < 1 || l.maxRecipientsPerBatch > 20 || l.perTxTokenUnits <= 0n) b.push("LIMITS_INCONSISTENT");
  }
  if (!c.allowlist.programs.length || !c.allowlist.mints.length) b.push("ALLOWLIST_EMPTY");
  if (c.signing.mode === "NONE") b.push("SIGNING_NOT_CONFIGURED");
  if (c.signing.mode === "HOT_KEY_CAPPED" && (c.addresses.REWARDS_TREASURY || c.addresses.OPERATIONS_TREASURY)) b.push("HOT_KEY_FORBIDDEN_FOR_TREASURIES");
  if (c.signing.mode === "MULTISIG_PROPOSAL" && !(c.signing.threshold && c.signing.signers && c.signing.threshold >= 2 && c.signing.threshold <= c.signing.signers)) b.push("MULTISIG_THRESHOLD_INVALID");
  if (c.reserves.operationsMinLamports === null) b.push("RESERVE_UNSET");
  if (!c.expiresAt) b.push("CONFIG_EXPIRY_UNSET"); else if (new Date(c.expiresAt) <= ctx.now) b.push("CONFIG_EXPIRED");
  if (c.paused) b.push("PAUSED");
  if (!c.approval || c.approval.by.length < 2) b.push("NOT_APPROVED");
  b.push("EXECUTION_NOT_IMPLEMENTED");
  return { executable: false as const, blockers: [...new Set(b)] };
}

/** Worker-side spend check (policy, not onchain). Fails closed on any unknown. */
export function checkSpend(l: Limits | null, spent: { window: bigint; day: bigint }, amount: bigint) {
  if (!l) return { ok: false as const, reason: "LIMITS_UNSET" };
  if (amount <= 0n) return { ok: false as const, reason: "NON_POSITIVE" };
  if (amount > l.perTxLamports) return { ok: false as const, reason: "PER_TX_CAP" };
  if (spent.window + amount > l.perWindowLamports) return { ok: false as const, reason: "PER_WINDOW_CAP" };
  if (spent.day + amount > l.perDayLamports) return { ok: false as const, reason: "PER_DAY_CAP" };
  return { ok: true as const };
}
