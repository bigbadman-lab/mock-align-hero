// Optional 0.05 SOL initial buy for the SOL rehearsal — a SEPARATE transaction, offered only after the
// creation transaction is confirmed and its final 60/25/15 fee config is verified on chain by Builder #2.
// Pure core with injected deps (route: src/routes/api/creator/launch-buy.ts). The mint always comes from
// the server-side permission row, never the browser. Nothing here signs; broadcast happens once, on request.
import { SESSION_TTL_MS } from "@/lib/creator-auth/core";
import type { BuilderCall, GateResult, GateSession } from "@/lib/tx-builder/launch-gate";
import { LAUNCH_AUTH_FRESH_MS } from "@/lib/tx-builder/launch-gate";
import { REHEARSAL_BUY_LAMPORTS, REHEARSAL_BUY_SLIPPAGE_BPS, type RehearsalDeps } from "@/lib/tx-builder/rehearsal";
import { b64, messageSigners, sameBytes, verifyAllSignatures } from "./tx-wire";

export const BUY_TTL_MS = 90_000;
export type BuyDeps = {
  rehearsal: RehearsalDeps; builder: BuilderCall; now: () => number;
  mac: (payload: string) => Promise<string>;
  send: (signedTxBase64: string) => Promise<{ ok: boolean; detail?: string }>;
  result: (signature: string, wallet: string, mint: string) => Promise<{ state: "pending" | "confirmed" | "failed"; tokensReceived?: string | null }>;
};
const err = (http: number, code: string): GateResult => ({ http, body: { ok: false, code } });
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

async function context(session: GateSession, connected: unknown, d: BuyDeps, fresh: boolean): Promise<GateResult | { wallet: string; mint: string }> {
  const r = d.rehearsal;
  if (!r.enabled || !r.configuredCreator) return err(503, "REHEARSAL_NOT_ENABLED");
  if (!session) return err(401, "CREATOR_SESSION_REQUIRED");
  if (session.wallet !== r.configuredCreator) return err(403, "REHEARSAL_NOT_PERMITTED");
  if (fresh && d.now() - (Date.parse(session.expiresAt) - SESSION_TTL_MS) > LAUNCH_AUTH_FRESH_MS) return err(401, "LAUNCH_REAUTH_REQUIRED");
  if (typeof connected !== "string" || connected !== session.wallet) return err(403, "CONNECTED_WALLET_MISMATCH");
  let p;
  try { p = await r.permission(); } catch { return err(503, "REHEARSAL_UNAVAILABLE"); }
  if (!p || p.creatorWallet !== session.wallet) return err(403, "REHEARSAL_NOT_PERMITTED");
  if ((p.status !== "SUBMITTED" && p.status !== "CONSUMED") || !p.mint) return err(409, "CREATION_NOT_SUBMITTED");
  return { wallet: session.wallet, mint: p.mint };
}

/** Is the created token confirmed with its final fee config? (Builder #2 reads the chain.) */
export async function buyStatus(input: { connectedWallet?: unknown }, session: GateSession, d: BuyDeps): Promise<GateResult> {
  const c = await context(session, input.connectedWallet, d, false);
  if ("http" in c) return c;
  let r;
  try { r = await d.builder("status", { schema: "mcpx.launch.status.v1", rehearsal: "SOL", creator: c.wallet, mint: c.mint }); } catch { return err(503, "BUILDER_UNREACHABLE"); }
  if (r.status !== 200) return err(503, String(r.body?.code ?? "STATUS_UNAVAILABLE"));
  const verified = r.body?.state === "CREATED_FEE_VERIFIED";
  return { http: 200, body: { ok: true, mint: c.mint, verified, state: String(r.body?.state ?? "UNKNOWN"), code: r.body?.code ?? null } };
}

export async function buyPrepare(input: { connectedWallet?: unknown }, session: GateSession, d: BuyDeps): Promise<GateResult> {
  const c = await context(session, input.connectedWallet, d, true);
  if ("http" in c) return c;
  let r;
  try {
    r = await d.builder("prepare-buy", { schema: "mcpx.launch.prepare-buy.v1", rehearsal: "SOL", idempotencyKey: crypto.randomUUID(), creator: c.wallet, mint: c.mint,
      mode: "buy_exact_quote_in_v3", quoteAmount: REHEARSAL_BUY_LAMPORTS, slippageBps: REHEARSAL_BUY_SLIPPAGE_BPS, format: "v0" });
  } catch { return err(503, "BUILDER_UNREACHABLE"); }
  if (r.status !== 200 || r.body?.status !== "UNSIGNED_BUY_CANDIDATE" || typeof r.body.messageBase64 !== "string") return err(409, String(r.body?.reasons?.[0] ?? r.body?.code ?? "BUY_NOT_AVAILABLE"));
  let signers: string[];
  try { signers = messageSigners(b64.dec(r.body.messageBase64)); } catch { return err(502, "BUY_TX_INVALID"); }
  if (signers.length !== 1 || signers[0] !== c.wallet) return err(502, "BUY_SIGNERS_MISMATCH");
  const expiresAt = d.now() + BUY_TTL_MS;
  const mac = await d.mac(`buy|${c.wallet}|${c.mint}|${expiresAt}|${r.body.messageBase64}`);
  const ev = r.body.evidence ?? {};
  return { http: 200, body: { ok: true, mint: c.mint, messageBase64: r.body.messageBase64, mac, expiresAt,
    quoteLamports: REHEARSAL_BUY_LAMPORTS, slippageBps: REHEARSAL_BUY_SLIPPAGE_BPS, estimatedTokens: typeof ev.quotedTokens === "string" ? ev.quotedTokens : null,
    simulation: typeof ev.simulation === "object" ? ev.simulation?.status ?? null : null } };
}

export async function buySubmit(input: { connectedWallet?: unknown; messageBase64?: unknown; mac?: unknown; expiresAt?: unknown; signedTxBase64?: unknown }, session: GateSession, d: BuyDeps): Promise<GateResult> {
  const c = await context(session, input.connectedWallet, d, true);
  if ("http" in c) return c;
  const { messageBase64: m, mac, expiresAt: x, signedTxBase64: s } = input;
  if (typeof m !== "string" || typeof mac !== "string" || typeof x !== "number" || typeof s !== "string") return err(400, "INVALID_INPUT");
  if (d.now() > x) return err(409, "BUY_EXPIRED");
  if ((await d.mac(`buy|${c.wallet}|${c.mint}|${x}|${m}`)) !== mac) return err(403, "BUY_TAMPERED");
  let v;
  try { v = await verifyAllSignatures(b64.dec(s)); } catch { return err(400, "INVALID_TRANSACTION"); }
  if (!sameBytes(v.message, b64.dec(m))) return err(403, "MESSAGE_ALTERED");
  if (!v.ok || v.signers.length !== 1 || v.signers[0] !== c.wallet) return err(403, "SIGNATURE_INVALID");
  let sent;
  try { sent = await d.send(s); } catch { return { http: 202, body: { ok: true, signature: v.firstSignature, uncertain: true } }; }
  if (!sent.ok) return { http: 502, body: { ok: false, code: "BROADCAST_FAILED", detail: sent.detail ?? "" } };
  return { http: 202, body: { ok: true, signature: v.firstSignature } };
}

export async function buyResult(input: { connectedWallet?: unknown; signature?: unknown }, session: GateSession, d: BuyDeps): Promise<GateResult> {
  const c = await context(session, input.connectedWallet, d, false);
  if ("http" in c) return c;
  if (typeof input.signature !== "string" || !SIG.test(input.signature) || !B58.test(c.mint)) return err(400, "INVALID_INPUT");
  try { return { http: 200, body: { ok: true, ...(await d.result(input.signature, c.wallet, c.mint)) } }; } catch { return err(503, "RPC_UNAVAILABLE"); }
}
