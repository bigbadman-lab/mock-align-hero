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
export type GateConfig = { enabled: boolean; opsRecipient: string | null; platformRecipient: string | null; nativeDeployer: string | null };
export type BuilderCall = (op: "prepare" | "inspect", body: unknown) => Promise<{ status: number; body: any }>;
export type GateDeps = { config: GateConfig; builder: BuilderCall; now: () => number };
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
function bindingMatches(b: any, ctx: BindingContext, mint?: string): string | null {
  if (!b || typeof b !== "object") return "BINDING_MISSING";
  if (b.creator !== ctx.sessionWallet) return "CREATOR_CHANGED_SINCE_PREPARE";
  if (mint !== undefined && b.mint !== mint) return "MINT_MISMATCH";
  const want = [[ctx.sessionWallet, 6000], [ctx.opsRecipient, 2500], [ctx.platformRecipient, 1500]];
  const sh = Array.isArray(b.shareholders) ? b.shareholders : [];
  if (sh.length !== 3 || sh.some((s: any, i: number) => s?.address !== want[i][0] || s?.bps !== want[i][1])) return "SHARES_MISMATCH";
  if ([b.creator, ctx.opsRecipient, ctx.platformRecipient].includes(ctx.nativeDeployer)) return "CREATOR_IS_NATIVE_DEPLOYER";
  return null;
}

export type PrepareInput = {
  idempotencyKey: string; mint: string; name: string; symbol: string; uri: string; format: TxFormat;
  initialBuy: null | { mode: BuyMode; quoteAmount: string; slippageBps: number };
  creator?: unknown; connectedWallet?: unknown;
};

export async function gatePrepare(input: PrepareInput, session: GateSession, d: GateDeps): Promise<GateResult> {
  const ctx = precheck(session, input.connectedWallet, d);
  if ("http" in ctx) return ctx;
  const { connectedWallet: _c, ...body } = input;
  const bound = bindLaunchCreator(body, ctx);
  if (!bound.ok) return err(bound.code === "FEE_RECIPIENTS_NOT_CONFIGURED" ? 503 : 403, bound.code);
  let r;
  try { r = await d.builder("prepare", bound.request); } catch { return err(503, "BUILDER_UNREACHABLE"); }
  if (r.status !== 200 || r.body?.status !== "UNSIGNED_CANDIDATE") return err(502, String(r.body?.code ?? r.body?.blockers?.[0] ?? "BUILDER_REFUSED"));
  const bad = bindingMatches(r.body.binding, ctx, input.mint);
  if (bad) return err(502, `BUILDER_${bad}`);
  return { http: 200, body: { ok: true, creator: ctx.sessionWallet, messageBase64: r.body.messageBase64, binding: r.body.binding, bindingMac: r.body.bindingMac } };
}

export type VerifyInput = { messageBase64: unknown; binding: unknown; bindingMac: unknown; connectedWallet?: unknown };

/** Called immediately before the wallet signs: same session, same wallet, untouched bytes. */
export async function gateVerify(input: VerifyInput, session: GateSession, d: GateDeps): Promise<GateResult> {
  const ctx = precheck(session, input.connectedWallet, d);
  if ("http" in ctx) return ctx;
  if (!ctx.connectedWallet) return err(403, "WALLET_DISCONNECTED");
  if (ctx.connectedWallet !== ctx.sessionWallet) return err(403, "CONNECTED_WALLET_MISMATCH");
  if (typeof input.messageBase64 !== "string" || typeof input.bindingMac !== "string") return err(400, "INVALID_INPUT");
  const bad = bindingMatches(input.binding, ctx);
  if (bad) return err(403, bad);
  let r;
  try { r = await d.builder("inspect", { messageBase64: input.messageBase64, binding: input.binding, bindingMac: input.bindingMac }); } catch { return err(503, "BUILDER_UNREACHABLE"); }
  const c = r.body?.checks ?? {};
  if (r.status !== 200 || r.body?.valid !== true) return err(403, String(r.body?.code ?? "CANDIDATE_INCONSISTENT"));
  if (!(c.payerIsCreator && c.signersExactlyCreatorAndMint && c.feeSharesExact)) return err(403, "CANDIDATE_INCONSISTENT");
  return { http: 200, body: { ok: true, creator: ctx.sessionWallet, launchReady: false } };
}
