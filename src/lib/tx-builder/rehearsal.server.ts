// Server-only wiring for the SOL rehearsal: env switches, the one-use permission (migration 0027, via
// service-role functions only) and the production lookup-table check read fresh from mainnet each time.
import type { RehearsalDeps, RehearsalPermission } from "./rehearsal";
import { checkAltUse } from "@/lib/launch/alt-check";
import { b64, messageSigners } from "@/lib/launch/tx-wire";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin = async (): Promise<any> => (await import("@/integrations/supabase/client.server")).supabaseAdmin;

export function rehearsalDeps(): RehearsalDeps {
  const c = process.env["MCPX_SOL_REHEARSAL_CREATOR"];
  return {
    enabled: process.env["MCPX_SOL_REHEARSAL"] === "1",
    configuredCreator: c && B58.test(c) ? c : null,
    async permission(): Promise<RehearsalPermission | null> {
      const { data, error } = await (await admin()).from("mcpx_sol_rehearsal").select("status, creator_wallet, draft_id, mint, signature").eq("id", 1).maybeSingle();
      if (error) throw new Error("unavailable");
      return data ? { status: data.status, creatorWallet: data.creator_wallet, draftId: data.draft_id, mint: data.mint, signature: data.signature } : null;
    },
    async reserve(wallet, draftId, mint) {
      const { data, error } = await (await admin()).rpc("mcpx_sol_rehearsal_reserve", { _wallet: wallet, _draft: draftId, _mint: mint });
      if (error) throw new Error("unavailable");
      return String(data);
    },
    async submit(wallet, mint, signature) {
      const { data, error } = await (await admin()).rpc("mcpx_sol_rehearsal_submit", { _wallet: wallet, _mint: mint, _sig: signature });
      if (error) throw new Error("unavailable");
      return String(data);
    },
  };
}

/** Reads the configured ALT at confirmed commitment right now; never trusts an earlier simulation. */
export async function checkAlt(messageBase64: string): Promise<string | null> {
  const expected = process.env["MCPX_LOOKUP_TABLE"];
  const msg = b64.dec(messageBase64);
  const signers = messageSigners(msg).length;
  if (!expected || !B58.test(expected)) return "ALT_NOT_CONFIGURED";
  const { siteRpcUrl } = await import("@/lib/solana-rpc.server");
  const r = await fetch(siteRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [expected, { encoding: "base64", commitment: "confirmed" }] }) });
  const j = await r.json().catch(() => null);
  if (!j || j.error) return "ALT_UNAVAILABLE";
  const v = j.result?.value;
  return checkAltUse(msg, signers, expected, v ? { owner: v.owner, data: b64.dec(v.data[0]) } : null);
}
