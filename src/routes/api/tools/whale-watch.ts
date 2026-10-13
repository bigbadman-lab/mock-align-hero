// Same-origin bounded proxy for Whale Watch. Shares the visitor + global budget with every tool.
// Visitors choose only an address and one of four fixed thresholds — never limits, programs or URLs.
import { createFileRoute } from "@tanstack/react-router";
import { isValidSolanaAddress } from "@/lib/tools/wallet-inspector";
import { WW_SCHEMA, WW_TOOL_ID, isValidThreshold, isWhaleWatchResult } from "@/lib/tools/whale-watch";
import { callWorker, json, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/whale-watch")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(WW_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > 256) return json(413, { error: "invalid_input" });
        let b: Record<string, unknown> | null;
        try { b = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).sort().join(",") !== "address,minLamports") return json(400, { error: "invalid_input" });
        const address = b["address"], minLamports = b["minLamports"];
        if (typeof address !== "string" || !isValidSolanaAddress(address) || !isValidThreshold(minLamports)) return json(400, { error: "invalid_input" });
        const lim = await takeShared(cfg, request, "whale_watch");
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" }); // fail closed
        const r = await callWorker(cfg, JSON.stringify({ schema: WW_SCHEMA, toolId: WW_TOOL_ID, input: { address, minLamports } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isWhaleWatchResult(r.out, address, minLamports)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: WW_TOOL_ID, executionId: r.out.executionId, complete: r.out.complete, transfers: r.out.transfers.length }));
        return json(200, r.out);
      },
    },
  },
});
