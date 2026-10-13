// REWARDS-EXEC-01 E05 — canonical mint onboarding + payout exclusions. Pure checks over facts fetched from chain.
// A mint that fails any check is never tracked; passing never authorizes spending (executionReadiness does that).
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const TOKEN_LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const BURN_ADDRESSES = new Set(["1nc1nerator11111111111111111111111111111111"]);

export type MintFacts = {
  mint: string; tokenProgram: string | null; createdByProgram: string | null; creator: string | null;
  quoteMint: string | null; bondingCurve: string | null; poolVaults: readonly string[]; holderRewardsBuiltIn: boolean | null;
};
const WSOL = "So11111111111111111111111111111111111111112";

export function onboardMint(f: MintFacts, expectedDeployer: string | null) {
  const b: string[] = [];
  // Token program is derived from the verified mint owner. create_v2 coins (native $MCP) are Token-2022; legacy
  // Pump coins are SPL Token. Anything else is refused. Pump/creator/SOL-pair/built-in-rewards checks are unchanged.
  if (f.tokenProgram !== TOKEN_2022 && f.tokenProgram !== TOKEN_LEGACY) b.push("WRONG_TOKEN_PROGRAM");
  if (f.createdByProgram !== PUMP_PROGRAM) b.push("NOT_A_PUMP_COIN");
  if (!f.creator) b.push("CREATOR_UNKNOWN");
  else if (expectedDeployer && f.creator !== expectedDeployer) b.push("CREATOR_FEE_RECIPIENT_MISMATCH");
  if (f.quoteMint !== WSOL) b.push("NOT_SOL_PAIRED");
  if (!f.bondingCurve) b.push("BONDING_CURVE_UNKNOWN");
  if (f.holderRewardsBuiltIn !== false) b.push("BUILTIN_HOLDER_REWARDS_NOT_OFF");
  return { ok: b.length === 0, blockers: b, tokenProgram: b.includes("WRONG_TOKEN_PROGRAM") ? null : f.tokenProgram };
}

/** Exclusions: deployer, burn, curve + pool vaults. Any off-curve owner not on the list pauses (ambiguity never pays). */
export function applyExclusions(rows: readonly { owner: string; amount: bigint; kind: "WALLET" | "PROGRAM" | "UNKNOWN" }[],
  x: { deployer: string; bondingCurve: string | null; poolVaults: readonly string[] }) {
  const known = new Set([x.deployer, ...BURN_ADDRESSES, ...(x.bondingCurve ? [x.bondingCurve] : []), ...x.poolVaults]);
  const eligible: { owner: string; amount: bigint }[] = [], excluded: string[] = [], ambiguous: string[] = [];
  for (const r of rows) {
    if (known.has(r.owner)) excluded.push(r.owner);
    else if (r.kind !== "WALLET") ambiguous.push(r.owner);
    else eligible.push({ owner: r.owner, amount: r.amount });
  }
  return ambiguous.length ? { kind: "HELD" as const, reason: "AMBIGUOUS_OWNERS", ambiguous } : { kind: "OK" as const, eligible, excluded };
}

/** Dust: entitlements below the minimum carry forward (never dropped, never invented). */
export function splitDust(rows: readonly { owner: string; amount: bigint }[], min: bigint) {
  return { pay: rows.filter((r) => r.amount >= min && r.amount > 0n), carry: rows.filter((r) => r.amount < min && r.amount > 0n) };
}
