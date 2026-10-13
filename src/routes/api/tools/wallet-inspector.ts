// Same-origin bounded proxy: browser → here → signed request → Render worker → Helius.
// Never forwards caller URLs/methods/networks. Never logs addresses, bodies or secrets.
import { createFileRoute } from "@tanstack/react-router";
import { WI_SCHEMA, WI_TOOL_ID, isValidSolanaAddress, isWalletInspectorResult } from "@/lib/tools/wallet-inspector";
import { callWorker, json, readSingleField, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/wallet-inspector")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(WI_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        const address = await readSingleField(request, "address", 256);
        if (address instanceof Response) return address;
        if (!isValidSolanaAddress(address)) return json(400, { error: "invalid_input" });
        const lim = await takeShared(cfg, request, "wallet_inspector");
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" }); // fail closed
        const r = await callWorker(cfg, JSON.stringify({ schema: WI_SCHEMA, toolId: WI_TOOL_ID, input: { address } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isWalletInspectorResult(r.out, address)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: WI_TOOL_ID, executionId: r.out.executionId, partial: r.out.partial, holdings: r.out.tokenHoldings.length }));
        return json(200, r.out);
      },
    },
  },
});
