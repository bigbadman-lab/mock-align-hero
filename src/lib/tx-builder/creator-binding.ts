// CREATOR_RECIPIENT_BINDING — the child's 60% creator recipient is ALWAYS the wallet of the signed-in
// creator session (SIWS-verified, src/lib/creator-auth). Browser-supplied creator addresses are never
// trusted: they may only be absent or identical. The native $MCP deployer, the 25% ops wallet and the
// 15% platform wallet can never be the creator. Every launch path must call bindLaunchCreator before
// talking to the builder, and checkCandidateBinding before handing a transaction to the wallet.
import { LAUNCH_PREPARE_SCHEMA, type LaunchPrepareContractV1 } from "./contract";

export type BindingContext = {
  sessionWallet: string | null;          // from the __Host-mcpx_creator session, server-side only
  connectedWallet: string | null;        // the wallet the browser says is connected (must match the session)
  nativeDeployer: string | null;         // mcpx_rw_config.deployer_wallet / MCPX_DEPLOYER_PUBLIC_KEY
  opsRecipient: string | null;
  platformRecipient: string | null;
};
export type BindResult = { ok: true; request: LaunchPrepareContractV1 } | { ok: false; code: string };

export function bindLaunchCreator(body: Omit<LaunchPrepareContractV1, "creator" | "schema"> & { creator?: unknown }, ctx: BindingContext): BindResult {
  if (!ctx.sessionWallet) return { ok: false, code: "CREATOR_SESSION_REQUIRED" };
  if (!ctx.connectedWallet) return { ok: false, code: "WALLET_DISCONNECTED" };
  if (ctx.connectedWallet !== ctx.sessionWallet) return { ok: false, code: "CONNECTED_WALLET_MISMATCH" };
  if (body.creator !== undefined && body.creator !== ctx.sessionWallet) return { ok: false, code: "CREATOR_WALLET_MISMATCH" };
  if (!ctx.opsRecipient || !ctx.platformRecipient) return { ok: false, code: "FEE_RECIPIENTS_NOT_CONFIGURED" };
  if (ctx.nativeDeployer && ctx.sessionWallet === ctx.nativeDeployer) return { ok: false, code: "CREATOR_IS_NATIVE_DEPLOYER" };
  if (ctx.sessionWallet === ctx.opsRecipient || ctx.sessionWallet === ctx.platformRecipient) return { ok: false, code: "CREATOR_IS_MCPX_RECIPIENT" };
  const { creator: _ignored, ...rest } = body;
  return { ok: true, request: { ...rest, schema: LAUNCH_PREPARE_SCHEMA, creator: ctx.sessionWallet } };
}

export type CandidateView = { feePayer: string; signers: string[]; mint: string; shareholders: { address: string; bps: number }[] };

/** Re-check the builder's returned candidate before the wallet signs it. */
export function checkCandidateBinding(c: CandidateView, ctx: BindingContext & { mint: string }): { ok: true } | { ok: false; code: string } {
  if (!ctx.sessionWallet) return { ok: false, code: "CREATOR_SESSION_REQUIRED" };
  if (c.feePayer !== ctx.sessionWallet) return { ok: false, code: "FEE_PAYER_NOT_CREATOR" };
  if (c.mint !== ctx.mint) return { ok: false, code: "MINT_MISMATCH" };
  if ([...c.signers].sort().join() !== [ctx.sessionWallet, ctx.mint].sort().join()) return { ok: false, code: "SIGNERS_MISMATCH" };
  const want = [[ctx.sessionWallet, 6000], [ctx.opsRecipient, 2500], [ctx.platformRecipient, 1500]];
  if (c.shareholders.length !== 3 || c.shareholders.some((s, i) => s.address !== want[i]![0] || s.bps !== want[i]![1])) return { ok: false, code: "SHARES_MISMATCH" };
  return { ok: true };
}
