// Final launch step. The browser sends the transaction its wallet signed. The server re-runs the full
// pre-sign check (builder MAC + draft + 60/25/15 + creator binding), confirms the signed message is
// byte-identical to the checked one, verifies both signatures (creator = session wallet, new mint),
// broadcasts it, and files the launch claim for on-chain verification. It never signs anything.
// Requires MCPX_CHILD_LAUNCH_ENABLED=1, MCPX_CHILD_LAUNCH_SIGNING=1 and MCPX_LAUNCH_VERIFIER=1.
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { gateVerify } from "@/lib/tx-builder/launch-gate";
import { builderCall, gateConfig } from "@/lib/tx-builder/client.server";
import { b64, sameBytes, verifyAllSignatures } from "@/lib/launch/tx-wire";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function loadDraft(wallet: string, id: string) {
  const { getDraft } = await import("@/lib/launch/drafts.server");
  const v = await getDraft(wallet, id);
  return v ? { id: v.id, revision: v.revision, templateId: v.input.templateId, name: v.input.tokenName, symbol: v.input.symbol, uri: v.metadata?.url ?? null } : null;
}

export const Route = createFileRoute("/api/creator/launch-submit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { ok: false, code: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: 64_000 });
        if (bad) return reply(bad === "forbidden" ? 403 : 400, { ok: false, code: bad });
        const config = gateConfig();
        if (!config.enabled || !config.signingEnabled || process.env["MCPX_LAUNCH_VERIFIER"] !== "1") return reply(503, { ok: false, code: "LAUNCH_SIGNING_NOT_ENABLED" });
        let b: any;
        try { b = JSON.parse(await request.text()); } catch { return reply(400, { ok: false, code: "INVALID_INPUT" }); }
        if (!b || typeof b.signedTxBase64 !== "string" || typeof b.messageBase64 !== "string" || typeof b.mint !== "string" || !B58.test(b.mint)) return reply(400, { ok: false, code: "INVALID_INPUT" });
        if (!(await takeAuthBudget(request))) return reply(429, { ok: false, code: "rate_limited" });
        let session;
        try { session = await currentSession(authStore, request); } catch { return reply(503, { ok: false, code: "unavailable" }); }
        if (!session) return reply(401, { ok: false, code: "CREATOR_SESSION_REQUIRED" });

        // 1. Same checks as immediately before signing.
        const v = await gateVerify({ messageBase64: b.messageBase64, binding: b.binding, bindingMac: b.bindingMac, connectedWallet: session.wallet, draftId: b.draftId, revision: b.revision },
          session, { config, builder: builderCall, now: () => Date.now(), loadDraft });
        if (v.http !== 200) return reply(v.http, v.body);
        if (b.binding?.mint !== b.mint) return reply(403, { ok: false, code: "MINT_MISMATCH" });

        // 2. The wallet signed exactly the checked bytes, and only the creator + new mint signed.
        let signed: Uint8Array, checked;
        try { signed = b64.dec(b.signedTxBase64); checked = await verifyAllSignatures(signed); } catch { return reply(400, { ok: false, code: "INVALID_TRANSACTION" }); }
        if (!sameBytes(checked.message, b64.dec(b.messageBase64))) return reply(403, { ok: false, code: "MESSAGE_ALTERED" });
        if (!checked.ok) return reply(403, { ok: false, code: "SIGNATURE_INVALID" });
        if (checked.signers.length !== 2 || checked.signers[0] !== session.wallet || checked.signers[1] !== b.mint) return reply(403, { ok: false, code: "SIGNERS_MISMATCH" });

        // 3. File the claim first (so a broadcast launch is always tracked), then broadcast.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db: any = (await import("@/integrations/supabase/client.server")).supabaseAdmin;
        const ins = await db.from("mcpx_cf_launch_claims").insert({ draft_id: b.draftId, draft_revision: b.revision, creator_wallet: session.wallet, mint: b.mint, signature: checked.firstSignature }).select("id").single();
        if (ins.error?.code === "23505") return reply(409, { ok: false, code: "already_claimed" });
        if (ins.error) return reply(503, { ok: false, code: "unavailable" });

        const rpc = process.env["MCPX_SOLANA_RPC_URL"] || "https://api.mainnet-beta.solana.com";
        try {
          const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b.signedTxBase64, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }] }) });
          const j = await r.json().catch(() => null);
          // A failed broadcast never lands; the verifier will mark the claim rejected once it expires.
          if (!j || j.error) return reply(502, { ok: false, code: "BROADCAST_FAILED", claimId: ins.data.id, detail: String(j?.error?.message ?? "").slice(0, 200) });
        } catch { return reply(202, { ok: true, claimId: ins.data.id, signature: checked.firstSignature, uncertain: true }); }
        return reply(202, { ok: true, claimId: ins.data.id, signature: checked.firstSignature });
      },
    },
  },
});
