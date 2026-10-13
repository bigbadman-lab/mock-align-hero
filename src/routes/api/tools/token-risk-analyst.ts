// Same-origin bounded proxy for Token Risk Analyst. Shares the visitor + global budget with every tool.
import { createFileRoute } from "@tanstack/react-router";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { TRA_SCHEMA, TRA_TOOL_ID, isTokenRiskResult } from "@/lib/tools/token-risk-analyst";
import { callWorker, json, readSingleField, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/token-risk-analyst")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(TRA_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        const mint = await readSingleField(request, "mint", 256);
        if (mint instanceof Response) return mint;
        if (!isValidSolanaAddress(mint)) return json(400, { error: "invalid_input" });
        const lim = await takeShared(cfg, request, TRA_TOOL_ID);
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" }); // fail closed
        const r = await callWorker(cfg, JSON.stringify({ schema: TRA_SCHEMA, toolId: TRA_TOOL_ID, input: { mint } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isTokenRiskResult(r.out, mint)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: TRA_TOOL_ID, executionId: r.out.executionId, status: r.out.status, unknown: r.out.summary?.unknown ?? null }));
        return json(200, r.out);
      },
    },
  },
});
