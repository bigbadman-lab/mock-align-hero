// SOL mainnet rehearsal (one-time, operator-approved). Pure core; persistence in rehearsal.server.ts.
// The mode is decided ONLY on the server from: MCPX_SOL_REHEARSAL=1, MCPX_SOL_REHEARSAL_CREATOR, the SIWS
// session wallet and the one-use permission row (migration 0027). The browser can never select SOL.
// The configured wallet never falls back to a $MCP launch, and nobody else ever reaches the SOL branch.
export const NATIVE_SOL = "So11111111111111111111111111111111111111112";

export type PermissionStatus = "AVAILABLE" | "RESERVED" | "SUBMITTED" | "CONSUMED" | "REVOKED";
export type RehearsalPermission = { status: PermissionStatus; creatorWallet: string; draftId: string | null; mint: string | null; signature: string | null };
export type RehearsalDeps = {
  enabled: boolean;
  configuredCreator: string | null;
  permission: () => Promise<RehearsalPermission | null>;
  /** mcpx_sol_rehearsal_reserve → reserved | already_reserved | not_permitted | busy | used */
  reserve: (wallet: string, draftId: string, mint: string) => Promise<string>;
  /** mcpx_sol_rehearsal_submit → submitted | already_submitted | mismatch */
  submit: (wallet: string, mint: string, signature: string) => Promise<string>;
};
export type RehearsalMode = { kind: "none" } | { kind: "sol"; permission: RehearsalPermission } | { kind: "blocked"; code: string };

/** prohibited = native deployer + 25% ops + 15% platform wallets: never a rehearsal creator. */
export async function rehearsalModeFor(sessionWallet: string | null, r: RehearsalDeps | undefined, prohibited: (string | null)[]): Promise<RehearsalMode> {
  if (!r || !r.enabled || !r.configuredCreator || !sessionWallet || sessionWallet !== r.configuredCreator) return { kind: "none" };
  if (prohibited.includes(sessionWallet)) return { kind: "blocked", code: "REHEARSAL_CREATOR_PROHIBITED" };
  let p: RehearsalPermission | null;
  try { p = await r.permission(); } catch { return { kind: "blocked", code: "REHEARSAL_UNAVAILABLE" }; }
  if (!p || p.creatorWallet !== sessionWallet) return { kind: "blocked", code: "REHEARSAL_NOT_PERMITTED" };
  if (p.status === "CONSUMED" || p.status === "REVOKED") return { kind: "blocked", code: "REHEARSAL_USED" };
  return { kind: "sol", permission: p };
}

/** May this (draft, mint) be prepared? AVAILABLE, or RESERVED by this exact attempt (retry after a declined signature). */
export function canPrepare(p: RehearsalPermission, draftId: string, mint: string): string | null {
  if (p.status === "AVAILABLE") return null;
  if (p.status === "RESERVED" && p.draftId === draftId && p.mint === mint) return null;
  return p.status === "SUBMITTED" ? "REHEARSAL_ALREADY_SUBMITTED" : "REHEARSAL_BUSY";
}

/** Immediately before signing: the permission must be reserved for exactly this draft + mint. */
export function canSign(p: RehearsalPermission, draftId: unknown, mint: unknown): string | null {
  if (p.status !== "RESERVED") return p.status === "SUBMITTED" ? "REHEARSAL_ALREADY_SUBMITTED" : "REHEARSAL_NOT_RESERVED";
  if (p.draftId !== draftId || p.mint !== mint) return "REHEARSAL_RESERVED_FOR_OTHER_ATTEMPT";
  return null;
}

/** Fixed initial buy for the rehearsal: 0.05 SOL, separate transaction after verified creation. */
export const REHEARSAL_BUY_LAMPORTS = "50000000";
export const REHEARSAL_BUY_SLIPPAGE_BPS = 500;
