// Website "Use Tool" execution for a launched product. Same visitor/global/free-test buckets as the Tool
// Library; never uses or requires the creator's product API key; MCP endpoint auth is unchanged.
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@/lib/tools/relay";

const MAX_BODY = 1024;
// Short per-isolate profile cache so a burst of runs can't turn into a burst of registry reads.
const CACHE_MS = 60_000;
const profiles = new Map<string, { at: number; v: Promise<import("@/lib/product-run").Resolved> }>();

export const Route = createFileRoute("/api/products/$slug/run")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json(413, { error: "invalid_input" });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        const [{ runProductTool }, relay, { resolveProfile }, { productionProfileDeps }] = await Promise.all([
          import("@/lib/product-run"), import("@/lib/tools/relay"), import("@/lib/product-profile"), import("@/lib/product-profile.server"),
        ]);
        const recordActivity = process.env["MCPX_TOOL_ACTIVITY"] === "1" ? (await import("@/lib/creator-dashboard/source.server")).recordActivity : undefined;
        const r = await runProductTool({
          resolve: (s) => {
            const hit = profiles.get(s);
            if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
            const v = resolveProfile(productionProfileDeps, s);
            if (profiles.size > 200) profiles.clear();
            profiles.set(s, { at: Date.now(), v });
            v.then((r) => { if (r.result.status === "unavailable") profiles.delete(s); }, () => profiles.delete(s));
            return v;
          },
          workerConfig: relay.workerConfig, toolAvailability: relay.toolAvailability, takeShared: relay.takeShared, callWorker: relay.callWorker,
          recordActivity,
        }, params.slug, body, request);
        return json(r.status, r.body);
      },
    },
  },
});
