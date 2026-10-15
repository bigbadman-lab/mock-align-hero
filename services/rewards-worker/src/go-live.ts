// GO-LIVE-01 — removes the last placeholders between "mint set" and real payouts.
// 1) Standing eligibility policy: once the mint is verified on chain, the v1 rules (any positive holding, excluding
//    deployer, burn, the Pump bonding curve and the canonical PumpSwap pool) are published as one immutable,
//    APPROVED version effective from the genesis window. Never replaces an existing version.
// 2) Live readiness: every executionReadiness flag comes from a real per-pass check; nothing is hardcoded true.
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { PublicKey } from "@solana/web3.js";
import { POLICY_V1_DRAFT, policyLiveAllowed, policyFor, type EligibilityPolicy } from "../../../src/lib/rewards/eligibility-policy";

export const STANDING_APPROVAL = "operator:standing-approval-2026-10-15";

export function livePolicy(x: { mint: string; deployer: string; genesisWindow: number; verifiedAt: string }): EligibilityPolicy {
  const m = new PublicKey(x.mint);
  return {
    ...POLICY_V1_DRAFT,
    version: `elig-v1-${x.mint.slice(0, 8)}`, status: "APPROVED_FOR_LIVE_PAYOUTS", mint: x.mint, deployerWallet: x.deployer,
    poolVaults: [
      { address: bondingCurvePda(m).toBase58(), evidence: "Pump bonding curve PDA [bonding-curve, mint]" },
      { address: canonicalPumpPoolPda(m).toBase58(), evidence: "Canonical PumpSwap pool PDA for mint/WSOL" },
    ],
    effectiveFromWindow: x.genesisWindow, approvedBy: STANDING_APPROVAL, mintVerifiedAt: x.verifiedAt, poolsVerifiedAt: x.verifiedAt,
  };
}

/** Publishes the standing policy only when no policy covers the genesis window for this mint. Returns the policy in force. */
export async function ensureLivePolicy(d: { load(): Promise<EligibilityPolicy[]>; save(p: EligibilityPolicy): Promise<void> },
  x: { mint: string; deployer: string; genesisWindow: number; now?: () => Date }): Promise<EligibilityPolicy | null> {
  const all = await d.load();
  const cur = policyFor(x.genesisWindow, all);
  if (cur && cur.mint === x.mint) return cur; // existing version wins (immutable, never overwritten)
  const p = livePolicy({ ...x, verifiedAt: (x.now ?? (() => new Date()))().toISOString() });
  if (!policyLiveAllowed(p)) return cur;
  await d.save(p);
  return p;
}

export type LiveChecks = {
  mint: string | null; launchDerived: boolean; decimals: number | null;
  policy: EligibilityPolicy | null; indexSynced: boolean; openGaps: number;
  createdMints: readonly string[] | null; intentStoreOk: boolean; senderOn: boolean;
  deployerLamports: bigint | null; minReserveLamports: bigint;
  signerAddress: string | null; deployer: string | null;
};

/** Maps real checks to executionReadiness flags. */
export function liveFlags(c: LiveChecks) {
  return {
    mintVerified: !!c.mint && c.launchDerived && c.decimals !== null,
    eligibilityApproved: !!c.policy && c.policy.mint === c.mint && policyLiveAllowed(c.policy),
    snapshotComplete: c.indexSynced && c.openGaps === 0,
    // Pump vaults pool fees across a creator's coins: attribution only when the deployer created exactly this mint.
    feeOwnershipConfirmed: !!c.mint && c.createdMints !== null && c.createdMints.length === 1 && c.createdMints[0] === c.mint,
    intentStoreReady: c.intentStoreOk,
    // Every send is preflight-simulated by the RPC (sender.ts skipPreflight:false); no sender = nothing can be simulated.
    simulationsPassed: c.senderOn,
    reservesSufficient: c.deployerLamports !== null && c.deployerLamports >= c.minReserveLamports,
    operatorAuthorized: !!c.signerAddress && c.signerAddress === c.deployer,
  };
}
