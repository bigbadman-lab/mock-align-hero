// Website "Use Tool" execution for a launched product. Same visitor/global/free-test buckets as the Tool
// Library; never uses or requires the creator's product API key; MCP endpoint auth is unchanged.
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@/lib/tools/relay";

const MAX_BODY = 256;

export const Route = createFileRoute("/api/products/$slug/run")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json(413, { error: "invalid_input" });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        const [{ runProductTool }, relay, { loadProfile }, { productionProfileDeps }] = await Promise.all([
          import("@/lib/product-run"), import("@/lib/tools/relay"), import("@/lib/product-profile"), import("@/lib/product-profile.server"),
        ]);
        const recordActivity = process.env["MCPX_TOOL_ACTIVITY"] === "1" ? (await import("@/lib/creator-dashboard/source.server")).recordActivity : undefined;
        const r = await runProductTool({
          loadProfile: (s) => loadProfile(productionProfileDeps, s),
          workerConfig: relay.workerConfig, toolAvailability: relay.toolAvailability, takeShared: relay.takeShared, callWorker: relay.callWorker,
          recordActivity,
        }, params.slug, body, request);
        return json(r.status, r.body);
      },
    },
  },
});
