// Phase 05-I — holder eligibility policy v1 as versioned, immutable, server-side data (never a frontend list).
// v1 rules: any positive finalized $MCP holding qualifies (no minimum). Excluded: native deployer wallet, proven burn
// destinations, identified pool/exchange vaults, MCPX-controlled reward/operational holdings. Child-token fee
// addresses are NOT automatic exclusions and no native treasuries are invented. Unknown/PDA/delegated/frozen owners
// are AMBIGUOUS → settlement holds. A policy changes only by publishing a new version with a later effective window;
// frozen snapshots keep the version they were frozen with (no retroactive mutation).
import { BURN_ADDRESSES, type ExclusionConfig } from "./eligibility";

export type PolicyStatus = "DRAFT" | "TEST_FIXTURE" | "APPROVED_FOR_LIVE_PAYOUTS";
export type Evidenced = { address: string; evidence: string };
export type EligibilityPolicy = {
  version: string; status: PolicyStatus; mint: string | null; deployerWallet: string | null;
  burn: Evidenced[]; poolVaults: Evidenced[]; mcpxHoldings: Evidenced[];
  resolvedOwners: Record<string, { decision: "ELIGIBLE" | "EXCLUDED"; evidence: string }>;
  effectiveFromWindow: number; approvedBy: string | null; mintVerifiedAt: string | null; poolsVerifiedAt: string | null;
};

export const POLICY_V1_DRAFT: EligibilityPolicy = {
  version: "elig-v1-draft", status: "DRAFT", mint: null, deployerWallet: null,
  burn: BURN_ADDRESSES.map((a) => ({ address: a, evidence: "Solana incinerator (no private key)" })),
  poolVaults: [], mcpxHoldings: [], resolvedOwners: {}, effectiveFromWindow: 0, approvedBy: null, mintVerifiedAt: null, poolsVerifiedAt: null,
};

export function policyBlockers(p: EligibilityPolicy): string[] {
  const b: string[] = [];
  if (p.status === "TEST_FIXTURE" && !p.version.startsWith("test-")) b.push("TEST_FIXTURE_VERSION_MUST_START_WITH_test-");
  if (p.status !== "APPROVED_FOR_LIVE_PAYOUTS") b.push(p.status === "TEST_FIXTURE" ? "TEST_FIXTURE_NEVER_LIVE" : "POLICY_NOT_APPROVED");
  if (!p.mint) b.push("MINT_NOT_SET");
  if (!p.deployerWallet) b.push("DEPLOYER_NOT_SET");
  if (!p.mintVerifiedAt) b.push("MINT_NOT_VERIFIED");
  if (!p.poolsVerifiedAt) b.push("POOL_ACCOUNTS_NOT_VERIFIED");
  if (!p.approvedBy) b.push("NO_APPROVER");
  for (const e of [...p.burn, ...p.poolVaults, ...p.mcpxHoldings]) if (!e.evidence.trim()) b.push(`NO_EVIDENCE:${e.address}`);
  if (p.version.startsWith("test-") && p.status === "APPROVED_FOR_LIVE_PAYOUTS") b.push("TEST_VERSION_CANNOT_BE_APPROVED");
  return b;
}
export const policyLiveAllowed = (p: EligibilityPolicy) => policyBlockers(p).length === 0;

/** Policy in force for a window: highest effectiveFromWindow ≤ window. Versions must be unique. */
export function policyFor(window: number, policies: readonly EligibilityPolicy[]): EligibilityPolicy | null {
  const vs = new Set<string>(); for (const p of policies) { if (vs.has(p.version)) throw new Error("DUPLICATE_POLICY_VERSION"); vs.add(p.version); }
  return [...policies].filter((p) => p.effectiveFromWindow <= window).sort((a, b) => b.effectiveFromWindow - a.effectiveFromWindow)[0] ?? null;
}

export function toExclusionConfig(p: EligibilityPolicy): ExclusionConfig {
  const resolved: ExclusionConfig["resolvedOwners"] = {};
  for (const [k, v] of Object.entries(p.resolvedOwners)) resolved[k] = v.decision;
  return { version: p.version, approved: policyLiveAllowed(p), poolVaults: p.poolVaults.map((x) => x.address), treasuries: [],
    reserves: p.mcpxHoldings.map((x) => x.address), deployer: p.deployerWallet ? [p.deployerWallet] : [], extraBurn: p.burn.map((x) => x.address), resolvedOwners: resolved };
}
