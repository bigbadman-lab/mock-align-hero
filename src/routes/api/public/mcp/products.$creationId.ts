// Product-scoped MCP endpoint (Phase 03-B implementation route). Resolves only verified creations with an
// active config and a valid product key. Creator BYOK (if active) adds an optional ai_summary to the one tool.
import { createFileRoute } from "@tanstack/react-router";
import { handleProductMcp, productionExecDeps } from "@/lib/mcp-gateway/server";
import { productionProductDeps } from "@/lib/mcp-gateway/products.server";

const h = async ({ request, params }: { request: Request; params: { creationId: string } }) => {
  const { productionAiDeps } = await import("@/lib/byok/store.server");
  // Tool activity is recorded only once the 0026 table is live and MCPX_TOOL_ACTIVITY=1 is set.
  const exec = process.env["MCPX_TOOL_ACTIVITY"] === "1"
    ? { ...productionExecDeps, recordActivity: (await import("@/lib/creator-dashboard/source.server")).recordActivity }
    : productionExecDeps;
  return handleProductMcp(params.creationId, request, productionProductDeps, exec, await productionAiDeps().catch(() => null));
};

export const Route = createFileRoute("/api/public/mcp/products/$creationId")({
  server: { handlers: { POST: h, GET: h, DELETE: h } },
});
