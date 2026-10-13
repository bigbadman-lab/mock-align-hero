// Same-origin bounded proxy for Transaction Verifier. Shares the visitor + global budget with every tool.
// Never logs signatures, bodies or secrets.
import { createFileRoute } from "@tanstack/react-router";
import { TV_SCHEMA, TV_TOOL_ID, isTransactionVerifierResult, isValidSignature } from "@/lib/tools/transaction-verifier";
import { callWorker, json, readSingleField, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/transaction-verifier")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(TV_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        const signature = await readSingleField(request, "signature", 256);
        if (signature instanceof Response) return signature;
        if (!isValidSignature(signature)) return json(400, { error: "invalid_input" });
        const lim = await takeShared(cfg, request, "transaction_verifier");
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" }); // fail closed
        const r = await callWorker(cfg, JSON.stringify({ schema: TV_SCHEMA, toolId: TV_TOOL_ID, input: { signature } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isTransactionVerifierResult(r.out, signature)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: TV_TOOL_ID, executionId: r.out.executionId, found: r.out.found, execution: r.out.execution }));
        return json(200, r.out);
      },
    },
  },
});
