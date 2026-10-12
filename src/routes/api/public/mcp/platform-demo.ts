// Platform demo/test MCP endpoint (Phase 03-A). Not a user product. Bearer-token protected.
import { createFileRoute } from "@tanstack/react-router";
import { PLATFORM_DEMO } from "@/lib/mcp-gateway/registry";
import { handleMcp } from "@/lib/mcp-gateway/server";

const h = ({ request }: { request: Request }) => handleMcp(PLATFORM_DEMO, request);

export const Route = createFileRoute("/api/public/mcp/platform-demo")({
  server: { handlers: { POST: h, GET: h, DELETE: h } },
});
