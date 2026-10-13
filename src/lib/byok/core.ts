// BYOK operations (server-only, injectable store). Wired to /api/creator/ai behind MCPX_BYOK_ENABLED (L7-B).
// Every operation re-checks: creator session present → session wallet owns the verified product (authorizeCreator).
// Responses never contain key material — not even a masked substring: only provider, model, status, health, limits, usage.
import { authorizeCreator, type OwnershipStore } from "@/lib/creator-auth/core";
import { aadFor, open, seal, type Keyring, type Sealed } from "./crypto";
import { getProvider, isSupportedModel, validateLimits, type Limits } from "./providers";
import { testOpenAiKey, type Health } from "./openai-test";

/** Stored in place of any key substring (DB column is deprecated). */
export const NO_HINT = "----";
export type ByokState = "not_connected" | "unchecked" | "paused" | "active" | "held" | "provider_error" | "revoked";

export const BYOK_ACTIONS = ["connect_or_replace", "test_connection", "get_status", "set_enabled", "set_model_and_limits", "rotate", "revoke_and_remove", "get_usage"] as const;
export type ByokAction = (typeof BYOK_ACTIONS)[number];

export interface ByokStatus {
  provider: string; model: string; status: "configured" | "revoked"; enabled: boolean; revision: number;
  hasKey: boolean; credentialVersion: number | null; limits: Limits; updatedAt: string;
  health: Health | "unchecked"; healthCredentialVersion: number | null; healthCheckedAt: string | null;
}
export interface ByokUsage { today: { requests: number; inputTokens: number; outputTokens: number; estCostMicros: number; failed: number; ambiguous: number }; inFlight: number }

export interface ByokStore {
  putCredential(p: { creationId: string; wallet: string; mode: "connect" | "rotate"; provider: string; sealed: Sealed; hint: string; model: string; idem: string; expectedRevision: number }): Promise<string>;
  revoke(p: { creationId: string; wallet: string; expectedRevision: number | null }): Promise<string>;
  setEnabled(p: { creationId: string; wallet: string; enabled: boolean; expectedRevision: number }): Promise<string>;
  setModelAndLimits(p: { creationId: string; wallet: string; model: string; limits: Limits; expectedRevision: number }): Promise<string>;
  getStatus(creationId: string): Promise<ByokStatus | null>;
  getUsage(creationId: string): Promise<ByokUsage>;
  recordHealth(p: { creationId: string; wallet: string; credentialVersion: number; health: Health }): Promise<string>;
  loadActiveCredential(creationId: string): Promise<{ version: number; idem: string; sealed: Sealed } | null>;
}

export interface ByokCtx {
  store: ByokStore; ownership: OwnershipStore; keyring: () => Promise<Keyring>; sessionWallet: string | null;
  /** Per-product budget for live connection tests (each may cost the creator a tiny provider charge). */
  takeTestBudget?: (creationId: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

/** One coarse state for the UI, derived only from server facts. "active" needs enabled + a passing check of the current key. */
export function deriveState(s: ByokStatus | null): ByokState {
  if (!s) return "not_connected";
  if (s.status === "revoked") return "revoked";
  if (!s.hasKey) return "not_connected";
  const current = s.healthCredentialVersion !== null && s.healthCredentialVersion === s.credentialVersion;
  if (!current || s.health === "unchecked") return "unchecked";
  if (s.health === "no_credit") return "held";
  if (s.health === "rate_limited" || s.health === "provider_error" || s.health === "no_permission" || s.health === "model_unavailable") return "provider_error";
  if (s.health === "invalid_key" || !s.enabled) return "paused";
  return "active";
}
const view = (s: ByokStatus | null) => ({ integration: s, state: deriveState(s) });
export type ByokResult = { status: number; body: Record<string, unknown> };

const IDEM = /^[A-Za-z0-9_-]{16,64}$/;
const ok = (body: Record<string, unknown>): ByokResult => ({ status: 200, body });
const err = (status: number, error: string): ByokResult => ({ status, body: { error } });
const CODE_STATUS: Record<string, number> = { ok: 200, replayed: 200, stale_revision: 409, revoked: 409, needs_passing_test: 409, not_found: 404, forbidden: 404 };
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
      return ok(view(await ctx.store.getStatus(creationId)));
    }
    case "get_usage": return ok({ usage: await ctx.store.getUsage(creationId) });
    case "test_connection": {
      const s = await ctx.store.getStatus(creationId);
      if (!s || !s.hasKey) return err(404, "not_found");
      if (s.status === "revoked") return err(409, "revoked");
      const p = getProvider(s.provider);
      if (!p || !isSupportedModel(p, s.model)) return err(400, "unsupported_model");
      if (!ctx.takeTestBudget || !(await ctx.takeTestBudget(creationId))) return err(429, "rate_limited");
      const cred = await ctx.store.loadActiveCredential(creationId);
      if (!cred) return err(404, "not_found");
      let health: Health;
      try {
        const apiKey = await open(await ctx.keyring(), cred.sealed, aadFor(creationId, cred.idem));
        health = await testOpenAiKey(p, apiKey, s.model, ctx.fetchImpl);
      } catch { return err(503, "unavailable"); }
      // A result for a key replaced mid-test is dropped ("stale"); invalid_key auto-pauses inside the same locked update.
      const code = await ctx.store.recordHealth({ creationId, wallet, credentialVersion: cred.version, health });
      if (code === "stale") return err(409, "stale_revision");
      if (code !== "ok") return fromCode(code);
      return ok({ health, ...view(await ctx.store.getStatus(creationId)) });
    }
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
      const code = await ctx.store.putCredential({ creationId, wallet, mode: action === "rotate" ? "rotate" : "connect", provider: p.id, sealed, hint: NO_HINT, model, idem: input.idempotencyKey, expectedRevision: expected });
      // The key is never echoed back, not even masked beyond the last 4 characters.
      return fromCode(code, code === "ok" || code === "replayed" ? view(await ctx.store.getStatus(creationId)) : {});
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
