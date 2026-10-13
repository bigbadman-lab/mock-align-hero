// L7-A provider allowlist. OpenAI only in MVP. Endpoints are fixed here — creators can never supply a base URL (SSRF).
export interface ProviderSpec {
  id: string;
  label: string;
  endpoint: string; // fixed, https, known host
  models: readonly string[];
  keyPattern: RegExp;
}

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = Object.freeze({
  openai: {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-4o-mini", "gpt-4.1-mini"],
    keyPattern: /^sk-[A-Za-z0-9_-]{20,200}$/,
  },
});

/** Server-enforced ceilings (mirrored by DB CHECKs in 0014). */
export const LIMIT_CEILINGS = Object.freeze({
  maxConcurrency: { min: 1, max: 4 },
  maxPerMinute: { min: 1, max: 30 },
  maxPerDay: { min: 1, max: 2000 },
  maxInputTokens: { min: 256, max: 8000 },
  maxOutputTokens: { min: 64, max: 1024 },
});
export type Limits = { -readonly [K in keyof typeof LIMIT_CEILINGS]: number };
export const DEFAULT_LIMITS: Limits = { maxConcurrency: 1, maxPerMinute: 6, maxPerDay: 200, maxInputTokens: 4000, maxOutputTokens: 600 };

export const getProvider = (id: unknown): ProviderSpec | null =>
  typeof id === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id]! : null;

export const isSupportedModel = (p: ProviderSpec, m: unknown): m is string => typeof m === "string" && p.models.includes(m);

export function validateLimits(x: unknown): Limits | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== Object.keys(LIMIT_CEILINGS).sort().join(",")) return null;
  const out = {} as Limits;
  for (const [k, c] of Object.entries(LIMIT_CEILINGS) as [keyof Limits, { min: number; max: number }][]) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < c.min || v > c.max) return null;
    out[k] = v;
  }
  return out;
}

/** Only the last 4 characters are ever kept for display. */
export const keyHint = (k: string) => k.slice(-4);
