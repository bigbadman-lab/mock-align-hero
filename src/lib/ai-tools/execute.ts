// Shared OpenAI execution adapter for the five Entertainment & Experimental AI tools. Server-only callers
// (route handlers, MCP gateway, product runner); process.env is read only inside functions.
// Order: kill switch → key present → per-isolate concurrency → platform-wide AI spend buckets → one bounded call.
import { AI_MAX_TEXT, type AiToolDef } from "./defs";

export const AI_TOOL_TIMEOUT_MS = 15_000;
export const AI_DEFAULT_MODEL = "gpt-4o-mini";
export const AI_ALLOWED_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"];
export const AI_MAX_CONCURRENT = 4; // per server isolate
export const AI_DEFAULT_LIMITS = { perMinute: 30, perDay: 2000 }; // platform-wide, all five tools together
const MAX_RESPONSE = 32 * 1024;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export type AiRun = { ok: true; out: Record<string, unknown> } | { ok: false; status: number; error: string };
export interface AiEnv { apiKey: string | undefined; model: string; disabled: boolean; perMinute: number; perDay: number }
export interface AiExecDeps {
  env(): AiEnv;
  /** Platform-wide counter (true = allowed). Errors → fail closed. */
  take(bucket: string, windowSeconds: number, limit: number): Promise<boolean>;
  fetchImpl?: typeof fetch;
}

const int = (v: string | undefined, d: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : d; };
export function readAiEnv(): AiEnv {
  const m = process.env["MCPX_AI_TOOLS_MODEL"] ?? "";
  return {
    apiKey: process.env["OPENAI_API_KEY"],
    model: AI_ALLOWED_MODELS.includes(m) ? m : AI_DEFAULT_MODEL,
    disabled: process.env["MCPX_AI_TOOLS_DISABLED"] === "1",
    perMinute: int(process.env["MCPX_AI_TOOLS_PER_MINUTE"], AI_DEFAULT_LIMITS.perMinute, 300),
    perDay: int(process.env["MCPX_AI_TOOLS_PER_DAY"], AI_DEFAULT_LIMITS.perDay, 50_000),
  };
}

export const productionAiDeps: AiExecDeps = {
  env: readAiEnv,
  async take(bucket, window, limit) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("mcpx_rate_limit_take", { _bucket: bucket, _window_seconds: window, _limit: limit });
    if (error) throw new Error("limiter");
    return data === true;
  },
};

/** Is AI execution switched on and configured? Never reveals why beyond a reason code. */
export function aiAvailability(deps: AiExecDeps = productionAiDeps): { available: boolean; reason?: string } {
  const e = deps.env();
  if (e.disabled) return { available: false, reason: "disabled" };
  if (!e.apiKey) return { available: false, reason: "not_configured" };
  return { available: true };
}

let inflight = 0;

async function readBounded(r: Response): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return "";
  let out = ""; const dec = new TextDecoder();
  while (out.length < MAX_RESPONSE) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  void reader.cancel().catch(() => {});
  return out.slice(0, MAX_RESPONSE);
}

/** Run one AI tool. `input` must already be validated by `d.inputSchema`. */
export async function runAiTool(d: AiToolDef, input: Record<string, unknown>, deps: AiExecDeps = productionAiDeps): Promise<AiRun> {
  const e = deps.env();
  if (e.disabled || !e.apiKey) return { ok: false, status: 503, error: "unavailable" };
  if (inflight >= AI_MAX_CONCURRENT) return { ok: false, status: 503, error: "busy" };
  inflight++;
  try {
    try {
      if (!(await deps.take("ai:global:m", 60, e.perMinute))) return { ok: false, status: 429, error: "rate_limited" };
      // The shared limiter accepts windows of at most 1 hour, so the daily cap is enforced as perDay/24 per hour (never more than perDay a day).
      if (!(await deps.take("ai:global:h", 3600, Math.max(1, Math.floor(e.perDay / 24))))) return { ok: false, status: 429, error: "rate_limited" };
    } catch { return { ok: false, status: 503, error: "unavailable" }; }

    const hist = Array.isArray(input["history"]) ? (input["history"] as { role: "user" | "assistant"; text: string }[]) : [];
    const messages = [
      { role: "system", content: d.system(input) },
      ...hist.map((h) => ({ role: h.role, content: h.text.slice(0, AI_MAX_TEXT) })),
      { role: "user", content: d.userMessage(input).slice(0, AI_MAX_TEXT + 40) },
    ];
    let r: Response;
    try {
      r = await (deps.fetchImpl ?? fetch)(OPENAI_URL, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(AI_TOOL_TIMEOUT_MS),
        headers: { authorization: `Bearer ${e.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: e.model, max_tokens: d.maxOutputTokens, temperature: 1, response_format: { type: "json_object" }, messages }),
      });
    } catch (x) {
      console.warn(JSON.stringify({ ai_tool: d.toolId, fetch_error: (x as Error)?.name ?? "unknown" }));
      return { ok: false, status: 504, error: (x as Error)?.name === "TimeoutError" || (x as Error)?.name === "AbortError" ? "timeout" : "provider_error" };
    }
    let body = "";
    try { body = await readBounded(r); } catch { /* empty */ }
    if (!r.ok) {
      // Status only — never the provider body (may echo request data).
      console.warn(JSON.stringify({ ai_tool: d.toolId, provider_status: r.status }));
      return { ok: false, status: r.status === 429 ? 429 : 502, error: r.status === 429 ? "rate_limited" : "provider_error" };
    }
    let parsed: unknown = null;
    try {
      const j = JSON.parse(body) as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] };
      const c = j.choices?.[0]?.message?.content;
      if (typeof c === "string") parsed = JSON.parse(c);
    } catch { parsed = null; }
    const fields = d.parseOutput(parsed, input);
    if (!fields) return { ok: false, status: 502, error: "bad_response" };
    console.log(JSON.stringify({ ai_tool: d.toolId, model: e.model, ok: true })); // no content logged
    return { ok: true, out: { schema: d.schema, toolId: d.toolId, model: e.model, generatedAt: new Date().toISOString(), entertainment: true, ...fields } };
  } finally { inflight--; }
}
