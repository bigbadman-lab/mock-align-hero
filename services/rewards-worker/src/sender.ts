// Broadcast for native $MCP rewards only. Sends ONLY bytes the executor already persisted (never builds or signs).
// Enabled by MCPX_REWARDS_BROADCAST=1; otherwise null (signed bytes stay HELD). Money still cannot move unless
// executionReadiness is EXECUTION_READY. The child-fee keeper never receives this sender.
import type { Sender } from "./executor";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

export function rpcSender(rpcUrl: string, fetchImpl: Fetch): Sender {
  return {
    async send(signedBase64: string) {
      const r = await fetchImpl(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        // skipPreflight false: the RPC simulates first; maxRetries 0: resends are decided only by reconcile (same bytes).
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [signedBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 }] }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json()) as { error?: { message?: string } };
      if (!r.ok || j.error !== undefined) throw new Error(j.error?.message ?? `send_http_${r.status}`);
    },
  };
}

export function readSender(env: (k: string) => string | null, fetchImpl: Fetch): Sender | null {
  const rpc = env("MCPX_REWARDS_RPC_URL");
  if (env("MCPX_REWARDS_BROADCAST") !== "1" || !rpc) return null;
  return rpcSender(rpc, fetchImpl);
}
