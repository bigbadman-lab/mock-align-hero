// L7-B: one bounded OpenAI connectivity check. Fixed endpoint, fixed body (1 output token, no tools), 10s timeout,
// response body read at most 4 KB and never returned. Only a coarse health code leaves this module.
import type { ProviderSpec } from "./providers";

export type Health = "ok" | "invalid_key" | "no_permission" | "no_credit" | "rate_limited" | "model_unavailable" | "provider_error";
export const TEST_TIMEOUT_MS = 10_000;
const MAX_BODY = 4096;

async function readBounded(r: Response): Promise<string> {
  try {
    const reader = r.body?.getReader();
    if (!reader) return "";
    let out = "";
    const dec = new TextDecoder();
    while (out.length < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    void reader.cancel().catch(() => {});
    return out.slice(0, MAX_BODY);
  } catch { return ""; }
}

/** Map a provider reply to a health code. Only a 401 is treated as proof of a bad key. */
export function classify(status: number, body: string): Health {
  let code = "", type = "";
  try { const e = (JSON.parse(body) as { error?: { code?: unknown; type?: unknown } }).error; code = String(e?.code ?? ""); type = String(e?.type ?? ""); } catch { /* opaque body */ }
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "invalid_key";
  if (code === "insufficient_quota" || type === "insufficient_quota") return "no_credit";
  if (status === 429) return "rate_limited";
  if (status === 404 || code === "model_not_found") return "model_unavailable";
  if (status === 403) return "no_permission"; // ambiguous: region/org/project permission — never "bad key"
  return "provider_error";
}

export async function testOpenAiKey(p: ProviderSpec, apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Promise<Health> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS);
  try {
    const r = await fetchImpl(p.endpoint, {
      method: "POST",
      redirect: "error",
      signal: ctl.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 }),
    });
    return classify(r.status, await readBounded(r));
  } catch {
    return "provider_error"; // timeout / network: transient, never proof of a bad key
  } finally { clearTimeout(t); }
}
