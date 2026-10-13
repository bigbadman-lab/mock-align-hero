// Same-origin bounded proxy for Smart Money Tracker. One request = one free test, regardless of wallet count.
import { createFileRoute } from "@tanstack/react-router";
import { SMT_SCHEMA, SMT_TOOL_ID, isSmartMoneyResult, parseWallets } from "@/lib/tools/smart-money-tracker";
import { callWorker, json, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/smart-money-tracker")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(SMT_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > 512) return json(413, { error: "invalid_input" });
        let b: unknown;
        try { b = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        const o = b as Record<string, unknown> | null;
        if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).join(",") !== "wallets") return json(400, { error: "invalid_input" });
        const wallets = parseWallets(o["wallets"]);
        if (!wallets) return json(400, { error: "invalid_input" });
        const lim = await takeShared(cfg, request, SMT_TOOL_ID);
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" });
        const r = await callWorker(cfg, JSON.stringify({ schema: SMT_SCHEMA, toolId: SMT_TOOL_ID, input: { wallets } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isSmartMoneyResult(r.out, wallets)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: SMT_TOOL_ID, executionId: r.out.executionId, complete: r.out.complete, calls: r.out.rpcCalls }));
        return json(200, r.out);
      },
    },
  },
});
