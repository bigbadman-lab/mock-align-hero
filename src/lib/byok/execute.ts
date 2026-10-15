// L7-C: product-scoped AI execution with the creator's own OpenAI key (server-only).
// Flow: state must be "active" → bounded input → atomic admission (concurrency/minute/UTC-day/token caps, row-locked)
// → one fixed OpenAI chat call (no tools, no URLs from callers, timeout, bounded body) → settle exactly once.
// Unknown outcome (timeout/network) settles "ambiguous" = charged at the reserved amount, so budgets never overshoot.
import { aadFor, open, type Keyring, type Sealed } from "./crypto";
import { deriveState, type ByokStatus } from "./core";
import { getProvider } from "./providers";
import { classify, type Health } from "./openai-test";

export const AI_TIMEOUT_MS = 20_000;
const MAX_RESPONSE = 64 * 1024;
const CHARS_PER_TOKEN = 3; // conservative over-estimate of tokens for reservation
const SYSTEM = "You summarise the JSON result of a read-only Solana tool for a non-technical reader. Use only facts present in the JSON. "
  + "Mention when data is partial or unknown. No financial advice, predictions or recommendations. At most 120 words, plain text.";
/** USD per 1M tokens (input, output) → micro-USD estimate. Public list prices; estimate only. */
const PRICE: Record<string, [number, number]> = { "gpt-4o-mini": [0.15, 0.6], "gpt-4.1-mini": [0.4, 1.6] };

export interface AiDeps {
  getStatus(creationId: string): Promise<ByokStatus | null>;
  loadActiveCredential(creationId: string): Promise<{ credentialId: string; version: number; idem: string; sealed: Sealed } | null>;
  admit(creationId: string, credentialId: string, ref: string, inTok: number, outTok: number): Promise<string>;
  settle(usageId: string, status: "settled" | "failed" | "ambiguous", inTok: number | null, outTok: number | null, costMicros: number | null): Promise<boolean>;
  recordHealth(p: { creationId: string; wallet: string; credentialVersion: number; health: Health }): Promise<string>;
  creatorWallet(creationId: string): Promise<string | null>;
  keyring(): Promise<Keyring>;
  fetchImpl?: typeof fetch;
}

export type AiOutcome =
  | { status: "ok"; model: string; text: string; usage: { inputTokens: number; outputTokens: number } }
  | { status: "not_available" | "paused" | "held" | "busy" | "rate_limited" | "daily_limit" | "too_large" | "provider_error" | "invalid_key" | "unavailable" };

/** Is AI usable for this product right now (drives whether the MCP tool advertises ai_summary)? */
export async function aiActive(d: AiDeps, creationId: string): Promise<boolean> {
  try { return deriveState(await d.getStatus(creationId)) === "active"; } catch { return false; }
}

const ref = () => "mcp_" + Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => b.toString(16).padStart(2, "0")).join("");

async function readBounded(r: Response): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return "";
  let out = ""; const dec = new TextDecoder();
  while (out.length < MAX_RESPONSE) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  void reader.cancel().catch(() => {});
  return out.slice(0, MAX_RESPONSE);
}

export async function summarise(d: AiDeps, creationId: string, result: unknown): Promise<AiOutcome> {
  let s: ByokStatus | null;
  try { s = await d.getStatus(creationId); } catch { return { status: "unavailable" }; }
  const state = deriveState(s);
  if (state === "held") return { status: "held" };
  if (state === "paused") return { status: "paused" };
  if (state !== "active" || !s) return { status: "not_available" };
  const p = getProvider(s.provider);
  if (!p || !p.models.includes(s.model)) return { status: "not_available" };

  // Bounded input: never more than the product's input-token cap (estimated conservatively).
  const budgetChars = Math.max(0, (s.limits.maxInputTokens - 200) * CHARS_PER_TOKEN);
  let json = JSON.stringify(result ?? null);
  if (json.length > budgetChars) json = json.slice(0, budgetChars) + "…[truncated]";
  const inTok = Math.min(s.limits.maxInputTokens, Math.ceil((json.length + SYSTEM.length) / CHARS_PER_TOKEN) + 20);
  const outTok = s.limits.maxOutputTokens;

  const cred = await d.loadActiveCredential(creationId).catch(() => null);
  if (!cred) return { status: "not_available" };
  const adm = await d.admit(creationId, cred.credentialId, ref(), inTok, outTok).catch(() => "unavailable");
  if (!adm.startsWith("admitted:")) {
    if (adm === "busy" || adm === "rate_limited" || adm === "daily_limit" || adm === "too_large" || adm === "paused") return { status: adm };
    return { status: adm === "unavailable" ? "unavailable" : "not_available" };
  }
  const usageId = adm.slice(9);

  let apiKey: string;
  try { apiKey = await open(await d.keyring(), cred.sealed, aadFor(creationId, cred.idem)); }
  catch { await d.settle(usageId, "failed", 0, 0, 0).catch(() => {}); return { status: "unavailable" }; }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  let r: Response;
  try {
    r = await (d.fetchImpl ?? fetch)(p.endpoint, {
      method: "POST", redirect: "manual", signal: ctl.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: s.model, max_tokens: outTok, temperature: 0.2,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: json }] }),
    });
  } catch {
    clearTimeout(t);
    await d.settle(usageId, "ambiguous", null, null, null).catch(() => {}); // unknown outcome → charged in full
    return { status: "provider_error" };
  }
  let body = "";
  try { body = await readBounded(r); } catch { /* treat as empty */ } finally { clearTimeout(t); }

  if (!r.ok) {
    const health = classify(r.status, body);
    await d.settle(usageId, r.status >= 500 ? "ambiguous" : "failed", 0, 0, 0).catch(() => {});
    if (health === "invalid_key" || health === "no_credit") {
      const wallet = await d.creatorWallet(creationId).catch(() => null);
      if (wallet) await d.recordHealth({ creationId, wallet, credentialVersion: cred.version, health }).catch(() => {}); // 401 → auto-pause (key kept)
      return { status: health === "invalid_key" ? "invalid_key" : "held" };
    }
    return { status: health === "rate_limited" ? "rate_limited" : "provider_error" };
  }
  let text = "", used = { inputTokens: inTok, outputTokens: outTok };
  try {
    const j = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const c = j.choices?.[0]?.message?.content;
    text = typeof c === "string" ? c.slice(0, 4000) : "";
    const pi = Number(j.usage?.prompt_tokens), po = Number(j.usage?.completion_tokens);
    if (Number.isFinite(pi) && Number.isFinite(po)) used = { inputTokens: pi, outputTokens: po };
  } catch { /* unparseable 200 → ambiguous */ }
  if (!text) { await d.settle(usageId, "ambiguous", null, null, null).catch(() => {}); return { status: "provider_error" }; }
  const [pin, pout] = PRICE[s.model] ?? [0, 0];
  await d.settle(usageId, "settled", used.inputTokens, used.outputTokens, Math.ceil(used.inputTokens * pin + used.outputTokens * pout)).catch(() => {});
  return { status: "ok", model: s.model, text, usage: used };
}
