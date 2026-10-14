// Website execution of a launched product's tool (server-only callers). Reuses the exact Tool Library
// path: same input check, same shared + per-tool free-test buckets, same signed worker call, same output
// validation. No creator API key is used; the MCP endpoint and its bearer auth are untouched.
import type { ProfileResult } from "./product-profile";
import { isValidSolanaAddress } from "./tools/wallet-inspector";
import { TS_SCHEMA, TS_TOOL_ID, isTokenScannerResult } from "./tools/token-scanner";
import type { callWorker, takeShared, toolAvailability, workerConfig } from "./tools/relay";
import { track, type ActivityRecorder } from "./mcp-gateway/server";

/** Templates with a finished website interface. Others keep MCP-only behaviour. */
interface WebRunner {
  toolId: string;
  /** Validates the exact external input; returns null when invalid. */
  parseInput(body: unknown): Record<string, string> | null;
  payload(input: Record<string, string>): string;
  validOutput(out: unknown, input: Record<string, string>): boolean;
}
export const WEB_RUNNERS: Record<string, WebRunner> = {
  "token-scanner": {
    toolId: TS_TOOL_ID,
    parseInput(b) {
      if (!b || typeof b !== "object" || Array.isArray(b)) return null;
      const o = b as Record<string, unknown>;
      if (Object.keys(o).join(",") !== "mint" || typeof o["mint"] !== "string") return null;
      const mint = o["mint"].trim();
      return isValidSolanaAddress(mint) ? { mint } : null;
    },
    payload: (i) => JSON.stringify({ schema: TS_SCHEMA, toolId: TS_TOOL_ID, input: { mint: i["mint"] } }),
    validOutput: (out, i) => isTokenScannerResult(out, i["mint"]!),
  },
};
export const isWebRunnable = (templateId: string) => Object.hasOwn(WEB_RUNNERS, templateId);

export interface RunDeps {
  loadProfile(slug: string): Promise<ProfileResult>;
  workerConfig: typeof workerConfig;
  toolAvailability: typeof toolAvailability;
  takeShared: typeof takeShared;
  callWorker: typeof callWorker;
  /** Present only when MCPX_TOOL_ACTIVITY=1. */
  recordActivity?: ActivityRecorder | undefined;
}
export interface RunReply { status: number; body: unknown }

export async function runProductTool(deps: RunDeps, slug: string, body: unknown, request: Request): Promise<RunReply> {
  const e = (status: number, error: string): RunReply => ({ status, body: { error } });
  let prof: ProfileResult;
  try { prof = await deps.loadProfile(slug); } catch { return e(503, "unavailable"); }
  if (prof.status === "unavailable") return e(503, "unavailable");
  if (prof.status === "not_found") return e(404, "not_found");
  const p = prof.profile;
  const runner = WEB_RUNNERS[p.templateId];
  if (!runner) return e(404, "not_runnable");
  if (p.availability !== "active" || !p.tool) return e(403, "product_inactive");
  const input = runner.parseInput(body);
  if (!input) return e(400, "invalid_input");
  const cfg = deps.workerConfig();
  if (!cfg) return e(503, "unavailable");
  const avail = await deps.toolAvailability(runner.toolId);
  if (!avail.available) return e(503, "unavailable");
  // Same per-tool free bucket as the Tool Library: one 3/day allowance per visitor per tool, not per product.
  const lim = await deps.takeShared(cfg, request, runner.toolId);
  if (lim === "limited") return e(429, "rate_limited");
  if (lim === "free_limit") return e(429, "free_limit");
  if (lim === "unavailable") return e(503, "unavailable");
  const r = await deps.callWorker(cfg, runner.payload(input), request);
  const ok = r.ok && runner.validOutput(r.out, input);
  await track(deps.recordActivity, p.creationId, runner.toolId, ok ? "ok" : "error"); // exactly one record per executed call
  if (!r.ok) return e(r.status, r.error);
  if (!ok) return e(502, "bad_response");
  return { status: 200, body: r.out };
}
