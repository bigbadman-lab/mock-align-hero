// Operator-only rewards diagnostics (server module, not exposed over HTTP in 05-A).
// Returns readiness blockers and ledger conservation totals; never addresses, secrets or balances that don't exist.
import { rewardsReadiness } from "./readiness";

export async function rewardsDiagnostics() {
  const readiness = rewardsReadiness({
    nativeMint: process.env["MCPX_NATIVE_MINT"] || null,
    feeReceiver: null, rewardsTreasury: null, operationsTreasury: null,
    swapSigner: false, payoutSigner: false, policyApproved: false, collectionProven: false, quoteMintProven: false,
  });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any).rpc("mcpx_rw_conservation");
  const ledger = error ? { state: "UNKNOWN" as const } : { state: "OK" as const, ...(Array.isArray(data) ? data[0] : data) };
  return { checkedAt: new Date().toISOString(), readiness, ledger };
}
