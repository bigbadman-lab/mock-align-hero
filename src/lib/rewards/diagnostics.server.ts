// Operator-only rewards diagnostics (server module, not exposed over HTTP).
// Returns readiness blockers, processor mode and ledger conservation totals; never addresses, secrets or balances that don't exist.
import { rewardsReadiness } from "./readiness";
import { configBlockers } from "./processor";

export async function rewardsDiagnostics() {
  const env = (k: string) => process.env[k] || null;
  const readiness = rewardsReadiness({
    nativeMint: env("MCPX_NATIVE_MINT"),
    feeReceiver: null, rewardsTreasury: env("MCPX_REWARDS_TREASURY"), operationsTreasury: env("MCPX_OPERATIONS_TREASURY"),
    swapSigner: false, payoutSigner: false, policyApproved: false, collectionProven: false, quoteMintProven: false,
  });
  const processor = {
    mode: "DRY_RUN" as const,
    blockers: [...configBlockers({ mint: env("MCPX_NATIVE_MINT"), sharingConfig: env("MCPX_NATIVE_SHARING_CONFIG"), rewardsTreasury: env("MCPX_REWARDS_TREASURY"), operationsTreasury: env("MCPX_OPERATIONS_TREASURY"), finalityLagSeconds: 0, minPayableLamports: 0n }),
      "HOLDER_INDEX_UNAVAILABLE", "PERSISTENT_PROCESSOR_STORE_NOT_DEPLOYED", "EXECUTION_NOT_APPROVED"],
    latestSealedWindow: null, unreconciledReceipts: null, // no persistent processor store yet → unknown, not zero
  };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any).rpc("mcpx_rw_conservation");
  const ledger = error ? { state: "UNKNOWN" as const } : { state: "OK" as const, ...(Array.isArray(data) ? data[0] : data) };
  return { checkedAt: new Date().toISOString(), readiness, processor, ledger };
}
