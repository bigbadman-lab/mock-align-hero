// External MCP gateway (server-only). Official SDK, stateless, JSON responses.
// Flow: client → Origin/size/auth checks → (product resolution) → SDK protocol → tool → shared rate limit → signed worker call.
import { McpServer, createMcpHandler, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { adaptersFor, type EndpointProfile, type ProductSettings, type TemplateAdapter } from "./registry";
import { parseCreationId, resolveProduct, type ProductDeps } from "./products";
import { callWorker, hmac, takeShared, toolAvailability, workerConfig } from "@/lib/tools/relay";
import * as z from "zod/v4";
import { aiActive, summarise, type AiDeps } from "@/lib/byok/execute";
import { CANVAS_TOOL, canvasInputSchema, canvasMarker, executeCanvasTool, parseCanvasVersion } from "./canvas";

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

/** Execution dependencies; production uses the shared relay (same buckets, same signed worker). */
export interface ExecDeps {
  workerConfig: typeof workerConfig;
  toolAvailability: typeof toolAvailability;
  takeShared: typeof takeShared;
  callWorker: typeof callWorker;
  /** Product endpoints only, and only once tool-activity tracking is switched on. Never affects results. */
  recordActivity?: ActivityRecorder;
}
export type ActivityRecorder = (e: { creationId: string; toolId: string; outcome: "ok" | "error"; ref: string }) => Promise<void>;
const ACTIVITY_TIMEOUT_MS = 1500;
/** One record per external call. Failures/timeouts are swallowed: no retry of the tool, no change to its result. */
export async function track(rec: ActivityRecorder | undefined, creationId: string, toolId: string, outcome: "ok" | "error"): Promise<void> {
  if (!rec) return;
  const ref = crypto.randomUUID();
  try {
    await Promise.race([rec({ creationId, toolId, outcome, ref }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ACTIVITY_TIMEOUT_MS))]);
  } catch {
    console.warn(JSON.stringify({ mcp: `product:${creationId}`, activity: "record_failed" }));
  }
}
export const productionExecDeps: ExecDeps = { workerConfig, toolAvailability, takeShared, callWorker };

interface ToolEntry { adapter: TemplateAdapter; settings: ProductSettings; description: string; scope: string;
  /** Present only on product endpoints whose creator BYOK is active: adds optional `ai_summary` input. */
  ai?: { deps: AiDeps; creationId: string };
  /** Set only for product endpoints: the canonical creation id activity is recorded against. */
  productId?: string }

function buildServer(info: { name: string; title: string }, entries: ToolEntry[], request: Request, exec: ExecDeps) {
  const server = new McpServer(
    { name: info.name, title: info.title, version: "0.3.1" },
    { instructions: "MCPX endpoint. Read-only Solana mainnet tools. Results are on-demand reads, not monitoring." },
  );
  for (const { adapter: a, settings, description, scope, ai, productId } of entries) {
    const schema = ai ? a.inputSchema.extend({ ai_summary: z.boolean().optional().describe("Also return a short plain-English AI summary (uses the product creator's OpenAI key; counted against the product's AI limits).") }) : a.inputSchema;
    server.registerTool(
      a.toolName,
      { title: a.title, description: ai ? `${description} Optional ai_summary adds a short AI explanation.` : description, inputSchema: schema as unknown as StandardSchemaWithJSON, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false } },
      async (raw: unknown) => {
        const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
        // Defence in depth: only the declared external fields reach the payload builder.
        const parsedAll = schema.safeParse(raw);
        if (!parsedAll.success) return fail("invalid_input");
        const { ai_summary: wantAi, ...rest } = parsedAll.data as Record<string, unknown>;
        const parsed = a.inputSchema.safeParse(rest); // AI flag never reaches the worker payload
        if (!parsed.success) return fail("invalid_input");
        const input = parsed.data as Record<string, unknown>;
        const cfg = exec.workerConfig();
        if (!cfg) return fail("unavailable: execution service not configured");
        const avail = await exec.toolAvailability(a.workerToolId);
        if (!avail.available) return fail("unavailable: tool not ready");
        const lim = await exec.takeShared(cfg, request); // same buckets as the website: MCP cannot bypass site quota
        if (lim === "limited") return fail("rate_limited: shared quota reached, retry later");
        if (lim === "unavailable") return fail("unavailable: rate limiter unavailable");
        const r = await exec.callWorker(cfg, a.toWorkerPayload(input, settings), request);
        const execOk = r.ok && a.validOutput(r.out, input, settings);
        if (productId) await track(exec.recordActivity, productId, a.workerToolId, execOk ? "ok" : "error");
        if (!r.ok) return fail(r.error);
        if (!execOk) return fail("bad_response");
        let out = r.out as Record<string, unknown>;
        if (ai && wantAi === true) {
          const o = await summarise(ai.deps, ai.creationId, out).catch(() => ({ status: "unavailable" as const }));
          out = { ...out, aiSummary: o.status === "ok" ? { status: "ok", model: o.model, text: o.text, source: "creator_openai_key" } : { status: o.status } };
        }
        console.log(JSON.stringify({ mcp: scope, tool: a.toolName, v: a.version, executionId: out["executionId"] }));
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

function preflight(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return err(403, "forbidden_origin");
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_MCP_BODY) return err(413, "too_large");
  return null;
}
const bearerOf = (request: Request) => {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};
const unauthorized = () => err(401, "unauthorized", { "www-authenticate": 'Bearer realm="mcpx"' });

async function serve(build: () => McpServer, request: Request) {
  const handler = createMcpHandler(build, { responseMode: "json", maxRequestBodySize: MAX_MCP_BODY });
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close().catch(() => {});
  }
}

/** Platform demo endpoint (Phase 03-A). Auth and Origin are checked before any protocol or worker work. */
export async function handleMcp(profile: EndpointProfile, request: Request, exec: ExecDeps = productionExecDeps): Promise<Response> {
  const expected = process.env["MCPX_MCP_TEST_TOKEN"];
  if (!expected || expected.length < 32) return err(503, "not_configured");
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return err(403, "forbidden_origin");
  const token = bearerOf(request);
  if (!token || !(await tokenMatches(token, expected))) return unauthorized();
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_MCP_BODY) return err(413, "too_large");
  const entries = adaptersFor(profile).map((a) => ({ adapter: a, settings: a.defaultSettings, description: a.description, scope: profile.id }));
  return serve(() => buildServer({ name: "mcpx-platform-demo", title: "MCPX platform demo (test)" }, entries, request, exec), request);
}

/**
 * Product-scoped endpoint. Order: Origin/size → ID shape → bearer present → verified creation + active config
 * → product credential → worker capability → exactly one tool. Unknown/inactive/misconfigured never reach the worker.
 */
export async function handleProductMcp(rawId: string, request: Request, deps: ProductDeps, exec: ExecDeps = productionExecDeps, aiDeps: AiDeps | null = null): Promise<Response> {
  const pre = preflight(request);
  if (pre) return pre;
  if (request.method !== "POST") return err(405, "method_not_allowed", { allow: "POST" });
  const id = parseCreationId(rawId);
  if (!id) return err(404, "not_found"); // no DB query for malformed IDs
  const token = bearerOf(request);
  if (!token) return unauthorized();
  // Canvas (Template 11): same endpoint, same order of checks, pipeline from the latest immutable version.
  let creation;
  try { creation = await deps.getVerifiedCreation(id); } catch { return err(503, "unavailable"); }
  if (creation?.templateId === "canvas") return handleCanvasProduct(id, creation.displayName, token, request, deps, exec, aiDeps);
  const cached = creation ?? null;
  const res = await resolveProduct({ ...deps, getVerifiedCreation: async () => cached }, id);
  if (!res.ok) {
    if (res.reason === "store_unavailable") return err(503, "unavailable");
    if (res.reason === "misconfigured") console.warn(JSON.stringify({ mcp: "product", correlationId: crypto.randomUUID(), creationId: id, error: "misconfigured" }));
    return err(404, "not_found"); // inactive / unknown / misconfigured are indistinguishable externally
  }
  const p = res.product;
  let authorized: boolean;
  try {
    authorized = await deps.authorizeProduct(p, token);
  } catch {
    console.warn(JSON.stringify({ mcp: "product", correlationId: crypto.randomUUID(), error: "key_store_unavailable" }));
    return err(503, "unavailable"); // never open on lookup failure
  }
  if (!authorized) return unauthorized();
  const avail = await exec.toolAvailability(p.adapter.workerToolId);
  if (!avail.available) return err(503, "unavailable");
  const entry: ToolEntry = {
    adapter: p.adapter,
    settings: p.settings,
    description: `${p.displayName} — ${p.adapter.description}`,
    scope: `product:${p.creationId}`,
    productId: p.creationId,
    ...(aiDeps && (await aiActive(aiDeps, p.creationId)) ? { ai: { deps: aiDeps, creationId: p.creationId } } : {}),
  };
  return serve(() => buildServer({ name: `mcpx-product-${p.creationId}`, title: p.displayName }, [entry], request, exec), request);
}

async function handleCanvasProduct(id: string, displayName: string, token: string, request: Request, deps: ProductDeps, exec: ExecDeps, aiDeps: AiDeps | null): Promise<Response> {
  let conf, ver;
  try { conf = await deps.getProductConfig(id); ver = deps.getCanvasVersion ? await deps.getCanvasVersion(id) : null; } catch { return err(503, "unavailable"); }
  if (!conf || conf.creationId !== id || conf.templateId !== "canvas" || conf.lifecycleState !== "active") return err(404, "not_found");
  const pv = parseCanvasVersion(ver ?? null);
  if (!pv) return err(404, "not_found"); // unbound or no longer valid against the catalog
  const marker = canvasMarker(pv.cfg, pv.version);
  const product = { creationId: id, displayName, adapter: marker, settings: {}, configVersion: conf.configVersion, accessMode: conf.accessMode };
  let authorized: boolean;
  try { authorized = await deps.authorizeProduct(product, token); } catch { return err(503, "unavailable"); }
  if (!authorized) return unauthorized();
  const cfg = exec.workerConfig();
  if (!cfg) return err(503, "unavailable");
  const ai = !!pv.cfg.ai && !!aiDeps && (await aiActive(aiDeps, id));
  const build = () => {
    const server = new McpServer({ name: `mcpx-product-${id}`, title: displayName, version: "0.3.1" },
      { instructions: "MCPX Canvas product. Read-only Solana mainnet pipeline of existing MCPX tools." });
    server.registerTool(CANVAS_TOOL,
      { title: marker.title, description: `${displayName} — ${marker.description}`, inputSchema: canvasInputSchema(pv.cfg, ai),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false } },
      async (raw: unknown) => {
        let executed = false; // record only requests that actually reached the execution worker
        const r = await executeCanvasTool(pv.cfg, pv.version, raw, {
          available: async (t) => (await exec.toolAvailability(t)).available,
          take: async () => { const l = await exec.takeShared(cfg, request); return l === "ok" ? "ok" : l === "unavailable" ? "unavailable" : "limited"; },
          execute: async (p) => { executed = true; const x = await exec.callWorker(cfg, p, request); return x.ok ? x : { ok: false, error: x.error }; },
          ...(ai && aiDeps ? { summarise: (o: unknown) => summarise(aiDeps, id, o) } : {}),
        });
        console.log(JSON.stringify({ mcp: `product:${id}`, tool: CANVAS_TOOL, canvasVersion: pv.version }));
        // One external Canvas request = one record, however many steps ran (steps are not recorded separately).
        if (executed) {
          const done = !(r as { isError?: boolean }).isError && (r as { structuredContent?: { complete?: unknown } }).structuredContent?.complete === true;
          await track(exec.recordActivity, id, "canvas", done ? "ok" : "error");
        }
        return r;
      });
    return server;
  };
  return serve(build, request);
}
