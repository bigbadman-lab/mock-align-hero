// Server-only rewards diagnostics: readiness + ledger conservation counters. GET, no input, no addresses or secrets returned.
import { createServerFn } from "@tanstack/react-start";
import { rewardsReadiness } from "./readiness";

export const getRewardsDiagnostics = createServerFn({ method: "GET" }).handler(async () => {
  const readiness = rewardsReadiness({
    nativeMint: process.env["MCPX_NATIVE_MINT"] || null,
    feeReceiver: null, rewardsTreasury: null, operationsTreasury: null,
    swapSigner: false, payoutSigner: false, policyApproved: false, collectionProven: false, quoteMintProven: false,
  });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any).rpc("mcpx_rw_conservation");
  const ledger = error ? { state: "UNKNOWN" as const } : { state: "OK" as const, ...(Array.isArray(data) ? data[0] : data) };
  return { checkedAt: new Date().toISOString(), readiness, ledger };
});
