// Creator submits "I launched draft X (revision R) as mint M in transaction S". This is only a request:
// Rewards Worker #3 independently verifies it on-chain (finalized) before anything is registered.
// Off unless MCPX_LAUNCH_VERIFIER=1 (needs migration 0025). Creator = session wallet, never the browser.
import { createFileRoute } from "@tanstack/react-router";
import { currentSession } from "@/lib/creator-auth/core";
import { authStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { readMutation, reply } from "@/lib/creator-auth/http.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B58 = (min: number, max: number) => new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${min},${max}}$`);

export const Route = createFileRoute("/api/creator/launch-claim")({
  server: {
    handlers: {
      // Status of one of the signed-in creator's own claims; a product slug appears only once verified.
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!UUID.test(id)) return reply(400, { error: "invalid_input" });
        if (process.env["MCPX_LAUNCH_VERIFIER"] !== "1") return reply(503, { error: "launch_verifier_not_enabled" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db: any = (await import("@/integrations/supabase/client.server")).supabaseAdmin;
          const { data: c, error } = await db.from("mcpx_cf_launch_claims").select("status, mint, signature, creation_id").eq("id", id).eq("creator_wallet", s.wallet).maybeSingle();
          if (error) return reply(503, { error: "unavailable" });
          if (!c) return reply(404, { error: "not_found" });
          let slug: string | null = null;
          if (c.status === "VERIFIED" && c.creation_id) {
            const p = await db.from("mcp_creations").select("slug").eq("id", c.creation_id).maybeSingle();
            slug = p.data?.slug ?? null;
          }
          // Until the verifier registers the product, report Solana's own view of the signature so the page can
          // say "token created" without waiting for registration. Read-only, bounded; unknown on any failure.
          const chain = c.status === "PENDING" ? await signatureState(c.signature) : null;
          return reply(200, { status: c.status, mint: c.mint, signature: c.signature, slug, chain }, { "cache-control": "no-store" });
        } catch { return reply(503, { error: "unavailable" }); }
      },
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { error: "unauthorized" });
        const b = await readMutation(request, ["draftId", "revision", "mint", "signature"]);
        if (b instanceof Response) return b;
        const { draftId, revision, mint, signature } = b as Record<string, unknown>;
        if (typeof draftId !== "string" || !UUID.test(draftId) || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1
          || typeof mint !== "string" || !B58(32, 44).test(mint) || typeof signature !== "string" || !B58(64, 88).test(signature)) return reply(400, { error: "invalid_input" });
        if (process.env["MCPX_LAUNCH_VERIFIER"] !== "1") return reply(503, { error: "launch_verifier_not_enabled" });
        if (!(await takeAuthBudget(request))) return reply(429, { error: "rate_limited" });
        try {
          const s = await currentSession(authStore, request);
          if (!s) return reply(401, { error: "unauthorized" });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table from pending 0025
          const db: any = (await import("@/integrations/supabase/client.server")).supabaseAdmin;
          const { data: d, error } = await db.from("mcpx_launch_drafts").select("id, revision, status").eq("id", draftId).eq("creator_wallet", s.wallet).neq("status", "ABANDONED").maybeSingle();
          if (error) return reply(503, { error: "unavailable" });
          if (!d) return reply(404, { error: "not_found" });
          if (d.revision !== revision) return reply(409, { error: "draft_changed" });
          const ins = await db.from("mcpx_cf_launch_claims").insert({ draft_id: draftId, draft_revision: revision, creator_wallet: s.wallet, mint, signature }).select("id, status").single();
          if (ins.error?.code === "23505") return reply(409, { error: "already_claimed" });
          if (ins.error) return reply(503, { error: "unavailable" });
          return reply(202, { claimId: ins.data.id, status: "PENDING_VERIFICATION" });
        } catch { return reply(503, { error: "unavailable" }); }
      },
    },
  },
});

async function signatureState(sig: string): Promise<"processed" | "confirmed" | "finalized" | "failed" | "unknown"> {
  try {
    const { siteRpcUrl } = await import("@/lib/solana-rpc.server");
    const r = await fetch(siteRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[sig], { searchTransactionHistory: true }] }) });
    const v = ((await r.json()) as { result?: { value?: ({ err: unknown; confirmationStatus?: string } | null)[] } }).result?.value?.[0];
    if (!v) return "unknown";
    if (v.err) return "failed";
    return v.confirmationStatus === "finalized" || v.confirmationStatus === "confirmed" || v.confirmationStatus === "processed" ? v.confirmationStatus : "unknown";
  } catch { return "unknown"; }
}
