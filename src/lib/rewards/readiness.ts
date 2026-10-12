// Native rewards readiness. Pure: given which prerequisites exist, list every blocker. Never reports "live".
export type RewardsBlocker =
  | "BLOCKED_NO_NATIVE_MINT"
  | "FEE_RECEIVER_NOT_DESIGNATED"
  | "REWARDS_TREASURY_NOT_DESIGNATED"
  | "OPERATIONS_TREASURY_NOT_DESIGNATED"
  | "SWAP_SIGNER_NOT_PROVISIONED"
  | "PAYOUT_SIGNER_NOT_PROVISIONED"
  | "ELIGIBILITY_POLICY_NOT_APPROVED"
  | "FEE_COLLECTION_PATH_NOT_PROVEN_ONCHAIN"
  | "QUOTE_MINT_ELIGIBILITY_NOT_PROVEN_ONCHAIN"
  | "EXECUTION_NOT_APPROVED";

export type RewardsInputs = {
  nativeMint: string | null; feeReceiver: string | null; rewardsTreasury: string | null; operationsTreasury: string | null;
  swapSigner: boolean; payoutSigner: boolean; policyApproved: boolean; collectionProven: boolean; quoteMintProven: boolean;
};

export function rewardsReadiness(i: RewardsInputs): { state: "BLOCKED"; blockers: RewardsBlocker[]; distributionsEnabled: false } {
  const b: RewardsBlocker[] = [];
  if (!i.nativeMint) b.push("BLOCKED_NO_NATIVE_MINT");
  if (!i.feeReceiver) b.push("FEE_RECEIVER_NOT_DESIGNATED");
  if (!i.rewardsTreasury) b.push("REWARDS_TREASURY_NOT_DESIGNATED");
  if (!i.operationsTreasury) b.push("OPERATIONS_TREASURY_NOT_DESIGNATED");
  if (!i.swapSigner) b.push("SWAP_SIGNER_NOT_PROVISIONED");
  if (!i.payoutSigner) b.push("PAYOUT_SIGNER_NOT_PROVISIONED");
  if (!i.policyApproved) b.push("ELIGIBILITY_POLICY_NOT_APPROVED");
  if (!i.collectionProven) b.push("FEE_COLLECTION_PATH_NOT_PROVEN_ONCHAIN");
  if (!i.quoteMintProven) b.push("QUOTE_MINT_ELIGIBILITY_NOT_PROVEN_ONCHAIN");
  b.push("EXECUTION_NOT_APPROVED"); // 05-A has no execution path at all
  return { state: "BLOCKED", blockers: b, distributionsEnabled: false };
}
