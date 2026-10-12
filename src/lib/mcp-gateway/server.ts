// External MCP gateway (server-only). Official SDK, stateless, JSON responses.
// Flow: client → bearer check → Origin check → SDK protocol handling → tool → shared rate limit → signed worker call.
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { adaptersFor, type EndpointProfile } from "./registry";
import { callWorker, hmac, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";

export const MAX_MCP_BODY = 8 * 1024;
const ALLOWED_ORIGINS = ["https://mcpx.fun", "https://www.mcpx.fun", "https://mock-align-hero.lovable.app"];

const err = (status: number, code: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: code } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

/** Constant-time token check via HMAC digests (equal length regardless of input). */
export async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmac("mcpx-auth", given), hmac("mcpx-auth", expected)]);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function buildServer(profile: EndpointProfile, request: Request) {
  const server = new McpServer(
    { name: "mcpx-platform-demo", title: "MCPX platform demo (test)", version: "0.3.0" },
    { instructions: "MCPX test endpoint. Read-only Solana mainnet tools. Results are on-demand reads, not monitoring." },
  );
  for (const a of adaptersFor(profile)) {
    server.registerTool(
      a.toolName,
      { title: a.title, description: a.description, inputSchema: a.inputSchema, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false } },
      async (input: Record<string, unknown>) => {
        const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
        const cfg = workerConfig();
        if (!cfg) return fail("unavailable: execution service not configured");
        const avail = await toolAvailability(a.workerToolId);
        if (!avail.available) return fail("unavailable: tool not ready");
        const lim = await takeShared(cfg, request); // same buckets as the website: MCP cannot bypass site quota
        if (lim === "limited") return fail("rate_limited: shared quota reached, retry later");
        if (lim === "unavailable") return fail("unavailable: rate limiter unavailable");
        const r = await callWorker(cfg, a.toWorkerPayload(input), request);
        if (!r.ok) return fail(r.error);
        if (!a.validOutput(r.out, input)) return fail("bad_response");
        const out = r.out as Record<string, unknown>;
        console.log(JSON.stringify({ mcp: profile.id, tool: a.toolName, v: a.version, executionId: out["executionId"], partial: out["partial"] }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out) }],
          structuredContent: JSON.parse(JSON.stringify(out)) as Record<string, unknown>,
          _meta: { "mcpx/templateId": a.templateId, "mcpx/templateVersion": a.version },
        };
      },
    );
  }
  return server;
}

/** Handles one HTTP request for a profile. Auth and Origin are checked before any protocol or worker work. */
export async function handleMcp(profile: EndpointProfile, request: Request): Promise<Response> {
  const expected = process.env["MCPX_MCP_TEST_TOKEN"];
  if (!expected || expected.length < 32) return err(503, "not_configured");
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return err(403, "forbidden_origin");
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await tokenMatches(token, expected))) return err(401, "unauthorized", { "www-authenticate": 'Bearer realm="mcpx"' });
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_MCP_BODY) return err(413, "too_large");
  const handler = createMcpHandler(() => buildServer(profile, request), { responseMode: "json", maxRequestBodySize: MAX_MCP_BODY });
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close().catch(() => {});
  }
}
