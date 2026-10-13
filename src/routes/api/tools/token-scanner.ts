// Same-origin bounded proxy for Token Scanner. Shares the visitor + global budget with every tool.
import { createFileRoute } from "@tanstack/react-router";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { TS_SCHEMA, TS_TOOL_ID, isTokenScannerResult } from "@/lib/tools/token-scanner";
import { callWorker, json, readSingleField, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/token-scanner")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(TS_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        const mint = await readSingleField(request, "mint", 256);
        if (mint instanceof Response) return mint;
        if (!isValidSolanaAddress(mint)) return json(400, { error: "invalid_input" });
        const lim = await takeShared(cfg, request, "token_scanner");
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" }); // fail closed
        const r = await callWorker(cfg, JSON.stringify({ schema: TS_SCHEMA, toolId: TS_TOOL_ID, input: { mint } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isTokenScannerResult(r.out, mint)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: TS_TOOL_ID, executionId: r.out.executionId, status: r.out.status, program: r.out.program }));
        return json(200, r.out);
      },
    },
  },
});
