// Website → transaction-builder launch gate (CHILD-FEES-01B creator binding). Pure core with injected
// deps; the route in src/routes/api/creator/launch-prepare.ts supplies the real session store and the
// HMAC-signed builder client. The 60% creator is ALWAYS the SIWS session wallet; a browser-claimed
// wallet is only cross-checked, never trusted. Nothing here signs, sends or spends.
import { SESSION_TTL_MS } from "@/lib/creator-auth/core";
import { bindLaunchCreator, type BindingContext } from "./creator-binding";
import type { BuyMode, TxFormat } from "./contract";

/** Wallet control must have been proven by a SIWS signature within this window. */
export const LAUNCH_AUTH_FRESH_MS = 10 * 60_000;

export type GateSession = { wallet: string; expiresAt: string } | null;
export type GateConfig = { enabled: boolean; signingEnabled?: boolean; opsRecipient: string | null; platformRecipient: string | null; nativeDeployer: string | null };
export type BuilderCall = (op: "prepare" | "inspect", body: unknown) => Promise<{ status: number; body: any }>;
/** Saved draft as owned by the session wallet (null = not theirs / missing). Metadata URI must exist. */
export type GateDraft = { id: string; revision: number; templateId: string; name: string; symbol: string; uri: string | null };
/** canonicalMint: the official $MCP mint from the site's rewards config (mcpx_rw_config.mint). Every child pairs with it;
 *  missing or unreadable fails closed so a mistyped builder MCPX_QUOTE_MINT can never pair children with another token. */
export type GateDeps = { config: GateConfig; builder: BuilderCall; now: () => number; loadDraft?: (wallet: string, id: string) => Promise<GateDraft | null>; canonicalMint?: () => Promise<string | null> };
export type GateResult = { http: number; body: Record<string, unknown> };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const err = (http: number, code: string): GateResult => ({ http, body: { ok: false, code } });

function precheck(session: GateSession, connected: unknown, d: GateDeps): GateResult | BindingContext {
  if (!d.config.enabled) return err(503, "CHILD_LAUNCH_NOT_ENABLED");
  if (!session) return err(401, "CREATOR_SESSION_REQUIRED");
  const issuedAt = Date.parse(session.expiresAt) - SESSION_TTL_MS;
  if (!(d.now() - issuedAt <= LAUNCH_AUTH_FRESH_MS)) return err(401, "LAUNCH_REAUTH_REQUIRED");
  if (!d.config.nativeDeployer) return err(503, "NATIVE_DEPLOYER_NOT_CONFIGURED");
  return {
    sessionWallet: session.wallet, connectedWallet: typeof connected === "string" && B58.test(connected) ? connected : null,
    nativeDeployer: d.config.nativeDeployer, opsRecipient: d.config.opsRecipient, platformRecipient: d.config.platformRecipient,
  };
}

/** The MAC-bound binding must name the session wallet at 60% and the server's own 25/15 wallets. */
async function canonical(d: GateDeps): Promise<string | GateResult> {
  let m: string | null = null;
  try { m = d.canonicalMint ? await d.canonicalMint() : null; } catch { return err(503, "CANONICAL_MINT_UNAVAILABLE"); }
  return m && B58.test(m) ? m : err(503, "CANONICAL_MINT_NOT_CONFIGURED");
}

function bindingMatches(b: any, ctx: BindingContext, mint: string | undefined, quoteMint: string): string | null {
  if (!b || typeof b !== "object") return "BINDING_MISSING";
  if (b.quoteMint !== quoteMint) return "QUOTE_MINT_NOT_CANONICAL";
  if (b.creator !== ctx.sessionWallet) return "CREATOR_CHANGED_SINCE_PREPARE";
  if (mint !== undefined && b.mint !== mint) return "MINT_MISMATCH";
  const want = [[ctx.sessionWallet, 6000], [ctx.opsRecipient, 2500], [ctx.platformRecipient, 1500]];
  const sh = Array.isArray(b.shareholders) ? b.shareholders : [];
  if (sh.length !== 3 || sh.some((s: any, i: number) => s?.address !== want[i]![0] || s?.bps !== want[i]![1])) return "SHARES_MISMATCH";
  if ([b.creator, ctx.opsRecipient, ctx.platformRecipient].includes(ctx.nativeDeployer)) return "CREATOR_IS_NATIVE_DEPLOYER";
  return null;
}

export type PrepareInput = {
  idempotencyKey: string; mint: string; name: string; symbol: string; uri: string; format: TxFormat;
  initialBuy: null | { mode: BuyMode; quoteAmount: string; slippageBps: number };
  creator?: unknown; connectedWallet?: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Launch from a saved draft: name/symbol/uri/template come from the creator's own stored draft, never the browser. */
export async function gatePrepareDraft(input: { draftId?: unknown; revision?: unknown; mint?: unknown; idempotencyKey?: unknown; connectedWallet?: unknown; creator?: unknown }, session: GateSession, d: GateDeps): Promise<GateResult> {
  const ctx = precheck(session, input.connectedWallet, d);
  if ("http" in ctx) return ctx;
  if (typeof input.draftId !== "string" || !UUID.test(input.draftId) || typeof input.revision !== "number" || typeof input.mint !== "string" || !B58.test(input.mint)
    || typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey)) return err(400, "INVALID_INPUT");
  if (!d.loadDraft) return err(503, "DRAFTS_UNAVAILABLE");
  let dr: GateDraft | null;
  try { dr = await d.loadDraft(ctx.sessionWallet!, input.draftId); } catch { return err(503, "DRAFTS_UNAVAILABLE"); }
  if (!dr) return err(404, "DRAFT_NOT_FOUND");
  if (dr.revision !== input.revision) return err(409, "DRAFT_CHANGED");
  if (!dr.uri) return err(409, "METADATA_NOT_PREPARED");
  const r = await gatePrepare({ idempotencyKey: input.idempotencyKey, mint: input.mint, name: dr.name, symbol: dr.symbol, uri: dr.uri, initialBuy: null, format: "v0_alt", creator: input.creator, connectedWallet: input.connectedWallet }, session, d);
  if (r.http !== 200) return r;
  return { http: 200, body: { ...r.body, draft: { id: dr.id, revision: dr.revision, templateId: dr.templateId } } };
}

export async function gatePrepare(input: PrepareInput, session: GateSession, d: GateDeps): Promise<GateResult> {
  const ctx = precheck(session, input.connectedWallet, d);
  if ("http" in ctx) return ctx;
  const q = await canonical(d);
  if (typeof q !== "string") return q;
  const { connectedWallet: _c, ...body } = input;
  const bound = bindLaunchCreator(body, ctx);
  if (!bound.ok) return err(bound.code === "FEE_RECIPIENTS_NOT_CONFIGURED" ? 503 : 403, bound.code);
  let r;
  try { r = await d.builder("prepare", bound.request); } catch { return err(503, "BUILDER_UNREACHABLE"); }
  if (r.status !== 200 || r.body?.status !== "UNSIGNED_CANDIDATE") return err(502, String(r.body?.code ?? r.body?.blockers?.[0] ?? "BUILDER_REFUSED"));
  const bad = bindingMatches(r.body.binding, ctx, input.mint, q);
  if (bad) return err(502, `BUILDER_${bad}`);
  return { http: 200, body: { ok: true, creator: ctx.sessionWallet, messageBase64: r.body.messageBase64, binding: r.body.binding, bindingMac: r.body.bindingMac } };
}

export type VerifyInput = { messageBase64: unknown; binding: unknown; bindingMac: unknown; connectedWallet?: unknown; draftId?: unknown; revision?: unknown };

/** Called immediately before the wallet signs: same session, same wallet, untouched bytes. */
export async function gateVerify(input: VerifyInput, session: GateSession, d: GateDeps): Promise<GateResult> {
  const ctx = precheck(session, input.connectedWallet, d);
  if ("http" in ctx) return ctx;
  if (!ctx.connectedWallet) return err(403, "WALLET_DISCONNECTED");
  if (ctx.connectedWallet !== ctx.sessionWallet) return err(403, "CONNECTED_WALLET_MISMATCH");
  if (typeof input.messageBase64 !== "string" || typeof input.bindingMac !== "string") return err(400, "INVALID_INPUT");
  const q = await canonical(d);
  if (typeof q !== "string") return q;
  const bad = bindingMatches(input.binding, ctx, undefined, q);
  if (bad) return err(403, bad);
  // Draft-bound launches: the stored draft must be unchanged and still describe exactly this token.
  if (input.draftId !== undefined) {
    if (typeof input.draftId !== "string" || !UUID.test(input.draftId) || !d.loadDraft) return err(400, "INVALID_INPUT");
    let dr: GateDraft | null;
    try { dr = await d.loadDraft(ctx.sessionWallet!, input.draftId); } catch { return err(503, "DRAFTS_UNAVAILABLE"); }
    const b = input.binding as any;
    if (!dr) return err(404, "DRAFT_NOT_FOUND");
    if (dr.revision !== input.revision) return err(409, "DRAFT_CHANGED");
    if (b.name !== dr.name || b.symbol !== dr.symbol || b.uri !== dr.uri) return err(403, "DRAFT_MISMATCH");
  }
  let r;
  try { r = await d.builder("inspect", { messageBase64: input.messageBase64, binding: input.binding, bindingMac: input.bindingMac }); } catch { return err(503, "BUILDER_UNREACHABLE"); }
  const c = r.body?.checks ?? {};
  if (r.status !== 200 || r.body?.valid !== true) return err(403, String(r.body?.code ?? "CANDIDATE_INCONSISTENT"));
  if (!(c.payerIsCreator && c.signersExactlyCreatorAndMint && c.feeSharesExact)) return err(403, "CANDIDATE_INCONSISTENT");
  return { http: 200, body: { ok: true, creator: ctx.sessionWallet, launchReady: d.config.signingEnabled === true } };
}
