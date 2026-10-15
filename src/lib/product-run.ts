// Website execution of a launched product's tool (server-only callers). Uses the product's own MCP adapter
// and server-fixed settings, the same shared + per-tool free-test buckets as the Tool Library, and the same
// signed worker call. No creator API key is used; the MCP endpoint and its bearer auth are untouched.
import type { ProfileResult } from "./product-profile";
import type { ProductSettings, TemplateAdapter } from "./mcp-gateway/registry";
import type { callWorker, takeShared, toolAvailability, workerConfig } from "./tools/relay";
import { productionAiToolExec, track, type ActivityRecorder, type AiToolExec } from "./mcp-gateway/server";

/** Templates with a finished website interface (Canvas excluded: it spends the creator's AI key). */
export const WEB_RUNNABLE = ["token-scanner", "wallet-inspector", "whale-watch", "holder-intelligence", "token-risk-analyst", "smart-money-tracker", "onchain-report-builder",
  "gibberish-ai", "roast-bot", "excuse-machine", "conspiracy-potato", "argument-machine",
  "future-you", "web3-startup-roulette", "monster-factory", "pigeon-ceo"] as const;
export const isWebRunnable = (templateId: string) => (WEB_RUNNABLE as readonly string[]).includes(templateId);

export interface Resolved { result: ProfileResult; adapter: TemplateAdapter | null; settings: ProductSettings | null }
export interface RunDeps {
  resolve(slug: string): Promise<Resolved>;
  workerConfig: typeof workerConfig;
  toolAvailability: typeof toolAvailability;
  takeShared: typeof takeShared;
  callWorker: typeof callWorker;
  /** Present only when MCPX_TOOL_ACTIVITY=1. */
  recordActivity?: ActivityRecorder | undefined;
  /** Entertainment AI tools; defaults to the platform OpenAI adapter. */
  ai?: AiToolExec | undefined;
}
export interface RunReply { status: number; body: unknown }

export async function runProductTool(deps: RunDeps, slug: string, body: unknown, request: Request): Promise<RunReply> {
  const e = (status: number, error: string): RunReply => ({ status, body: { error } });
  let r0: Resolved;
  try { r0 = await deps.resolve(slug); } catch { return e(503, "unavailable"); }
  const prof = r0.result;
  if (prof.status === "unavailable") return e(503, "unavailable");
  if (prof.status === "not_found") return e(404, "not_found");
  const p = prof.profile;
  if (!isWebRunnable(p.templateId)) return e(404, "not_runnable");
  const a = r0.adapter, settings = r0.settings;
  if (p.availability !== "active" || !p.tool || !a || !settings || a.templateId !== p.templateId) return e(403, "product_inactive");
  const parsed = a.inputSchema.safeParse(body); // strict: only the declared external fields; settings are server-fixed
  if (!parsed.success) return e(400, "invalid_input");
  const input = parsed.data as Record<string, unknown>;
  const cfg = deps.workerConfig();
  if (!cfg) return e(503, "unavailable");
  const aiExec = a.engine === "ai" ? (deps.ai ?? (await productionAiToolExec())) : null;
  const avail = aiExec ? aiExec.available() : await deps.toolAvailability(a.workerToolId);
  if (!avail.available) return e(503, "unavailable");
  // Same per-tool free bucket as the Tool Library: one daily allowance per visitor per tool, not per product.
  const lim = await deps.takeShared(cfg, request, a.workerToolId);
  if (lim === "limited") return e(429, "rate_limited");
  if (lim === "free_limit") return e(429, "free_limit");
  if (lim === "unavailable") return e(503, "unavailable");
  const r = aiExec ? await aiExec.run(a.templateId, input) : await deps.callWorker(cfg, a.toWorkerPayload(input, settings), request);
  const ok = r.ok && a.validOutput(r.out, input, settings);
  await track(deps.recordActivity, p.creationId, a.workerToolId, ok ? "ok" : "error"); // exactly one record per executed call
  if (!r.ok) return e(r.status, r.error);
  if (!ok) return e(502, "bad_response");
  return { status: 200, body: r.out };
}
