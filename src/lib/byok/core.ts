// L7-A BYOK operations (server-only, injectable store). Not wired to any public route yet — see docs/BYOK_L7A.md.
// Every operation re-checks: creator session present → session wallet owns the verified product (authorizeCreator).
// Responses never contain key material: only provider, model, status, last-4 hint, limits and usage counts.
import { authorizeCreator, type OwnershipStore } from "@/lib/creator-auth/core";
import { aadFor, seal, type Keyring, type Sealed } from "./crypto";
import { getProvider, isSupportedModel, keyHint, validateLimits, type Limits } from "./providers";

export const BYOK_ACTIONS = ["connect_or_replace", "test_connection", "get_status", "set_enabled", "set_model_and_limits", "rotate", "revoke_and_remove", "get_usage"] as const;
export type ByokAction = (typeof BYOK_ACTIONS)[number];

export interface ByokStatus {
  provider: string; model: string; status: "configured" | "revoked"; enabled: boolean; revision: number;
  keyHint: string | null; credentialVersion: number | null; limits: Limits; updatedAt: string;
}
export interface ByokUsage { today: { requests: number; inputTokens: number; outputTokens: number; estCostMicros: number; failed: number; ambiguous: number }; inFlight: number }

export interface ByokStore {
  putCredential(p: { creationId: string; wallet: string; mode: "connect" | "rotate"; provider: string; sealed: Sealed; hint: string; model: string; idem: string; expectedRevision: number }): Promise<string>;
  revoke(p: { creationId: string; wallet: string; expectedRevision: number | null }): Promise<string>;
  setEnabled(p: { creationId: string; wallet: string; enabled: boolean; expectedRevision: number }): Promise<string>;
  setModelAndLimits(p: { creationId: string; wallet: string; model: string; limits: Limits; expectedRevision: number }): Promise<string>;
  getStatus(creationId: string): Promise<ByokStatus | null>;
  getUsage(creationId: string): Promise<ByokUsage>;
}

export interface ByokCtx { store: ByokStore; ownership: OwnershipStore; keyring: () => Promise<Keyring>; sessionWallet: string | null }
export type ByokResult = { status: number; body: Record<string, unknown> };

const IDEM = /^[A-Za-z0-9_-]{16,64}$/;
const ok = (body: Record<string, unknown>): ByokResult => ({ status: 200, body });
const err = (status: number, error: string): ByokResult => ({ status, body: { error } });
const CODE_STATUS: Record<string, number> = { ok: 200, replayed: 200, stale_revision: 409, revoked: 409, not_found: 404, forbidden: 404 };
const fromCode = (code: string, extra: Record<string, unknown> = {}): ByokResult =>
  code === "ok" || code === "replayed" ? ok({ result: code, ...extra }) : err(CODE_STATUS[code] ?? 400, code);
const rev = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

export interface ByokInput { provider?: unknown; apiKey?: unknown; model?: unknown; idempotencyKey?: unknown; expectedRevision?: unknown; enabled?: unknown; limits?: unknown }

export async function runByok(ctx: ByokCtx, creationId: unknown, action: unknown, input: ByokInput): Promise<ByokResult> {
  if (!ctx.sessionWallet) return err(401, "unauthorized");
  if (typeof action !== "string" || !(BYOK_ACTIONS as readonly string[]).includes(action)) return err(400, "invalid_input");
  if (typeof creationId !== "string") return err(400, "invalid_input");
  // Ownership on every request; unknown, foreign and suspended products are indistinguishable (404).
  if (!(await authorizeCreator(ctx.ownership, ctx.sessionWallet, creationId))) return err(404, "not_found");
  const wallet = ctx.sessionWallet;

  switch (action as ByokAction) {
    case "get_status": {
      const s = await ctx.store.getStatus(creationId);
      return ok({ integration: s });
    }
    case "get_usage": return ok({ usage: await ctx.store.getUsage(creationId) });
    case "test_connection":
      // L7-B implements the real provider call. Never report success before then.
      return err(501, "not_implemented");
    case "connect_or_replace":
    case "rotate": {
      const p = getProvider(input.provider);
      const apiKey = input.apiKey;
      if (!p || typeof apiKey !== "string" || !p.keyPattern.test(apiKey)) return err(400, "invalid_input");
      if (typeof input.idempotencyKey !== "string" || !IDEM.test(input.idempotencyKey)) return err(400, "invalid_input");
      const existing = await ctx.store.getStatus(creationId);
      const model = input.model === undefined && existing ? existing.model : input.model;
      if (!isSupportedModel(p, model)) return err(400, "unsupported_model");
      const expected = existing ? existing.revision : 1;
      if (existing && existing.status !== "revoked" && input.expectedRevision !== expected) return err(409, "stale_revision");
      const ring = await ctx.keyring();
      const sealed = await seal(ring, apiKey, aadFor(creationId, input.idempotencyKey));
      const code = await ctx.store.putCredential({ creationId, wallet, mode: action === "rotate" ? "rotate" : "connect", provider: p.id, sealed, hint: keyHint(apiKey), model, idem: input.idempotencyKey, expectedRevision: expected });
      // The key is never echoed back, not even masked beyond the last 4 characters.
      return fromCode(code, { integration: code === "ok" || code === "replayed" ? await ctx.store.getStatus(creationId) : undefined });
    }
    case "set_enabled": {
      if (typeof input.enabled !== "boolean" || !rev(input.expectedRevision)) return err(400, "invalid_input");
      return fromCode(await ctx.store.setEnabled({ creationId, wallet, enabled: input.enabled, expectedRevision: input.expectedRevision }));
    }
    case "set_model_and_limits": {
      const s = await ctx.store.getStatus(creationId);
      if (!s || s.status === "revoked") return err(404, "not_found");
      const p = getProvider(s.provider);
      const limits = validateLimits(input.limits);
      if (!p || !isSupportedModel(p, input.model)) return err(400, "unsupported_model");
      if (!limits || !rev(input.expectedRevision)) return err(400, "invalid_input");
      return fromCode(await ctx.store.setModelAndLimits({ creationId, wallet, model: input.model, limits, expectedRevision: input.expectedRevision }));
    }
    case "revoke_and_remove": {
      if (input.expectedRevision !== undefined && !rev(input.expectedRevision)) return err(400, "invalid_input");
      return fromCode(await ctx.store.revoke({ creationId, wallet, expectedRevision: (input.expectedRevision as number | undefined) ?? null }));
    }
  }
}

/** Strip anything that could carry a key from values headed to logs, errors or telemetry. */
export function redact(v: unknown): unknown {
  const s = JSON.stringify(v ?? null, (k, x) => (/^(apikey|api_key|authorization|ciphertext|iv|secret|key)$/i.test(k) ? "[redacted]" : x));
  return JSON.parse(s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"));
}
