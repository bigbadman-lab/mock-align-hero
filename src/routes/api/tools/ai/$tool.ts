// Tool Library relay for the five Entertainment & Experimental AI tools. Same visitor/global buckets and the
// same per-tool daily free bucket as every other tool (shared with launched product pages), then the platform AI adapter.
import { createFileRoute } from "@tanstack/react-router";
import { json, takeShared, workerConfig } from "@/lib/tools/relay";
import { AI_TOOL_BY_ID } from "@/lib/ai-tools/defs";

const MAX_BODY = 4 * 1024;

export const Route = createFileRoute("/api/tools/ai/$tool")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!AI_TOOL_BY_ID[params.tool]) return json(404, { available: false, reason: "not_found" });
        const { aiAvailability } = await import("@/lib/ai-tools/execute");
        return json(200, workerConfig() ? aiAvailability() : { available: false, reason: "not_configured" });
      },
      POST: async ({ request, params }) => {
        const d = AI_TOOL_BY_ID[params.tool];
        if (!d) return json(404, { error: "not_found" });
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json(413, { error: "invalid_input" });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        const parsed = d.inputSchema.safeParse(body);
        if (!parsed.success) return json(400, { error: "invalid_input" });
        const cfg = workerConfig(); // its secret keys the visitor hash; the AI call itself never touches the worker
        if (!cfg) return json(503, { error: "unavailable" });
        const { aiAvailability, runAiTool } = await import("@/lib/ai-tools/execute");
        if (!aiAvailability().available) return json(503, { error: "unavailable" });
        const lim = await takeShared(cfg, request, d.toolId);
        if (lim === "limited") return json(429, { error: "rate_limited" });
        if (lim === "free_limit") return json(429, { error: "free_limit" });
        if (lim === "unavailable") return json(503, { error: "unavailable" });
        const r = await runAiTool(d, parsed.data as Record<string, unknown>);
        return r.ok ? json(200, r.out) : json(r.status, { error: r.error });
      },
    },
  },
});
