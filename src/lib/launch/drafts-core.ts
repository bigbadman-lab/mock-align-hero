// Pure request parsing for creator launch drafts (Phase 04-E). The wallet never comes from the body.
import type { DraftState } from "./lifecycle";
import { validateDraft, type Draft, type DraftInput, type FieldErrors } from "./draft";

export const DRAFT_BODY_MAX = 12288;
export const MAX_ACTIVE_DRAFTS = 20;
export const MAX_ARTIFACTS_PER_WALLET = 80;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const INPUT_KEYS = ["templateId", "settings", "productName", "tokenName", "symbol", "description", "link", "buyEnabled", "buyAmount", "slippageBps"].sort().join(",");

export type Parsed =
  | { action: "create"; createKey: string; draft: Draft }
  | { action: "update"; id: string; revision: number; draft: Draft }
  | { action: "abandon" | "prepare_metadata" | "get"; id: string; revision: number | null }
  | { error: "invalid_input" }
  | { error: "invalid_draft"; fields: FieldErrors };

function input(v: unknown): DraftInput | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k !== "toolDescription" && k !== "canvas").sort().join(",");
  if (keys !== INPUT_KEYS) return null;
  if ("toolDescription" in o && (typeof o["toolDescription"] !== "string" || (o["toolDescription"] as string).length > 1000)) return null;
  for (const k of ["templateId", "productName", "tokenName", "symbol", "description", "link", "buyAmount", "slippageBps"]) if (typeof o[k] !== "string" || (o[k] as string).length > 1000) return null;
  if (typeof o["buyEnabled"] !== "boolean") return null;
  if ("canvas" in o && o["canvas"] !== null && (typeof o["canvas"] !== "object" || JSON.stringify(o["canvas"]).length > 4096)) return null;
  const s = o["settings"];
  if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length > 4 || Object.values(s).some((x) => typeof x !== "string" || x.length > 40)) return null;
  return o as unknown as DraftInput;
}

export function parseDraftBody(b: Record<string, unknown>): Parsed {
  const a = b["action"];
  const keys = Object.keys(b).sort().join(",");
  const rev = b["revision"];
  const okRev = (r: unknown): r is number => Number.isInteger(r) && (r as number) >= 1 && (r as number) < 1e9;
  if (a === "create") {
    if (keys !== "action,createKey,draft" || typeof b["createKey"] !== "string" || !KEY_RE.test(b["createKey"])) return { error: "invalid_input" };
    const i = input(b["draft"]); if (!i) return { error: "invalid_input" };
    const v = validateDraft(i); if (!v.ok) return { error: "invalid_draft", fields: v.errors };
    return { action: "create", createKey: b["createKey"], draft: v.draft };
  }
  if (a === "update") {
    if (keys !== "action,draft,id,revision" || typeof b["id"] !== "string" || !UUID_RE.test(b["id"]) || !okRev(rev)) return { error: "invalid_input" };
    const i = input(b["draft"]); if (!i) return { error: "invalid_input" };
    const v = validateDraft(i); if (!v.ok) return { error: "invalid_draft", fields: v.errors };
    return { action: "update", id: b["id"], revision: rev, draft: v.draft };
  }
  if (a === "abandon" || a === "prepare_metadata") {
    if (keys !== "action,id,revision" || typeof b["id"] !== "string" || !UUID_RE.test(b["id"]) || !okRev(rev)) return { error: "invalid_input" };
    return { action: a, id: b["id"], revision: rev };
  }
  if (a === "get") {
    if (keys !== "action,id" || typeof b["id"] !== "string" || !UUID_RE.test(b["id"])) return { error: "invalid_input" };
    return { action: "get", id: b["id"], revision: null };
  }
  return { error: "invalid_input" };
}

/** Rebuild the editable form input from a stored, validated draft. */
export function toInput(d: Draft): DraftInput {
  return {
    templateId: d.templateId, settings: d.settings, productName: d.productName, toolDescription: d.toolDescription ?? "", tokenName: d.tokenName, symbol: d.symbol,
    description: d.description, link: d.link ?? "", buyEnabled: !!d.initialBuy, buyAmount: d.initialBuy?.amountMcp ?? "",
    slippageBps: String(d.initialBuy?.slippageBps ?? 100),
    ...(d.canvas ? { canvas: d.canvas } : {}),
  };
}

export interface DraftView {
  id: string; revision: number; status: DraftState; chainStatus: "NOT_STARTED";
  input: DraftInput;
  artwork: { url: string; width: number; height: number; bytes: number; type: string; sha256: string } | null;
  metadata: { url: string; sha256: string } | null;
  updatedAt: string;
}
