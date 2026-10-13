// Same-origin bounded proxy for Onchain Report Builder. One report = one free test; the worker composes
// components in-process (never re-entering these relays), so shared capacity is still taken once per request.
import { createFileRoute } from "@tanstack/react-router";
import { ORB_SCHEMA, ORB_TOOL_ID, isOnchainReport, validTarget, type TargetType } from "@/lib/tools/onchain-report";
import { callWorker, json, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const Route = createFileRoute("/api/tools/onchain-report-builder")({
  server: {
    handlers: {
      GET: async () => json(200, await toolAvailability(ORB_TOOL_ID)),
      POST: async ({ request }) => {
        const cfg = workerConfig();
        if (!cfg) return json(503, { error: "unavailable" });
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > 256) return json(413, { error: "invalid_input" });
        let b: unknown;
        try { b = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        const o = b as Record<string, unknown> | null;
        if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== "target,targetType" || !validTarget(o["targetType"], o["target"])) return json(400, { error: "invalid_input" });
        const targetType = o["targetType"] as TargetType, target = o["target"] as string;
        const lim = await takeShared(cfg, request, ORB_TOOL_ID);
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" });
        const r = await callWorker(cfg, JSON.stringify({ schema: ORB_SCHEMA, toolId: ORB_TOOL_ID, input: { targetType, target } }), request);
        if (!r.ok) return json(r.status, { error: r.error });
        if (!isOnchainReport(r.out, targetType, target)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: ORB_TOOL_ID, executionId: r.out.executionId, status: r.out.status, calls: r.out.usage.rpcCalls }));
        return json(200, r.out);
      },
    },
  },
});
