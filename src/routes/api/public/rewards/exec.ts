import { createFileRoute } from "@tanstack/react-router";
import { prepareBatch } from "@/lib/rewards/remote";
import { checkSealed, deny, okJson } from "@/lib/rewards/remote.server";

// Rewards worker → site: sealed statement batch, executed atomically. Worker-only (HMAC seal + single-use nonce).
export const Route = createFileRoute("/api/public/rewards/exec")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const c = await checkSealed(request, "/api/public/rewards/exec");
        if (c instanceof Response) return c;
        let steps;
        try { steps = prepareBatch(JSON.parse(c.body)?.steps); }
        catch (e) { return deny(400, e instanceof Error ? e.message.slice(0, 40) : "BAD_BATCH"); }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await (supabaseAdmin as any).rpc("mcpx_rw_remote_exec", { p_steps: steps });
        if (error) {
          const m = /MCPX_ABORT:([A-Z_]+)/.exec(String(error.message ?? ""));
          if (m) return okJson({ aborted: m[1], results: [] });
          console.error(JSON.stringify({ svc: "rewards-bridge", event: "exec_failed", code: error.code ?? null }));
          return deny(500, "EXEC_FAILED");
        }
        return okJson({ aborted: null, results: data });
      },
    },
  },
});
