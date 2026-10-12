// Product-scoped MCP endpoint (Phase 03-B implementation route). Resolves only verified creations with an
// active config; per-product credentials are not issued yet, so every request currently fails closed.
import { createFileRoute } from "@tanstack/react-router";
import { handleProductMcp } from "@/lib/mcp-gateway/server";
import { productionProductDeps } from "@/lib/mcp-gateway/products.server";

const h = ({ request, params }: { request: Request; params: { creationId: string } }) =>
  handleProductMcp(params.creationId, request, productionProductDeps);

export const Route = createFileRoute("/api/public/mcp/products/$creationId")({
  server: { handlers: { POST: h, GET: h, DELETE: h } },
});
