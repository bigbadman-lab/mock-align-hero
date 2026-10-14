// SOL rehearsal only: optional, separate 0.05 SOL initial buy after verified creation (creator cookie + CSRF).
// POST { op: "status" | "prepare" | "submit" | "result", ... }. Never signs; broadcasts once when asked.
import { createFileRoute } from "@tanstack/react-router";
import { checkMutation, currentSession } from "@/lib/creator-auth/core";
import { authStore, takeAuthBudget } from "@/lib/creator-auth/store.server";
import { reply } from "@/lib/creator-auth/http.server";
import { builderCall } from "@/lib/tx-builder/client.server";
import { buyPrepare, buyResult, buyStatus, buySubmit, type BuyDeps } from "@/lib/launch/rehearsal-buy";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function rpc(method: string, params: unknown[]) {
  const { siteRpcUrl } = await import("@/lib/solana-rpc.server");
  const r = await fetch(siteRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json().catch(() => null);
}

async function deps(): Promise<BuyDeps> {
  const { rehearsalDeps } = await import("@/lib/tx-builder/rehearsal.server");
  return {
    rehearsal: rehearsalDeps(), builder: builderCall, now: () => Date.now(),
    async mac(payload) {
      const secret = process.env["MCPX_TX_BUILDER_SECRET"];
      if (!secret) throw new Error("not configured");
      const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(`site-buy:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload)));
    },
    async send(tx) {
      const j = await rpc("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
      return !j || j.error ? { ok: false, detail: String(j?.error?.message ?? "").slice(0, 200) } : { ok: true };
    },
    async result(sig, wallet, mint) {
      const j = await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (!j || j.error) throw new Error("rpc");
      const t = j.result;
      if (!t) return { state: "pending" };
      if (t.meta?.err) return { state: "failed" };
      const bal = (xs: any[] | undefined) => BigInt((xs ?? []).find((b) => b.owner === wallet && b.mint === mint)?.uiTokenAmount?.amount ?? "0");
      return { state: "confirmed", tokensReceived: (bal(t.meta?.postTokenBalances) - bal(t.meta?.preTokenBalances)).toString() };
    },
  };
}

export const Route = createFileRoute("/api/creator/launch-buy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("authorization")) return reply(401, { ok: false, code: "unauthorized" });
        const bad = checkMutation(request, { maxBytes: 64_000 });
        if (bad) return reply(bad === "forbidden" ? 403 : 400, { ok: false, code: bad });
        let b: any;
        try { b = JSON.parse(await request.text()); } catch { return reply(400, { ok: false, code: "INVALID_INPUT" }); }
        if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { ok: false, code: "INVALID_INPUT" });
        if ((b.op === "prepare" || b.op === "submit") && !(await takeAuthBudget(request))) return reply(429, { ok: false, code: "rate_limited" });
        let session;
        try { session = await currentSession(authStore, request); } catch { return reply(503, { ok: false, code: "unavailable" }); }
        const d = await deps();
        const { op, ...rest } = b;
        const r = op === "status" ? await buyStatus(rest, session, d) : op === "prepare" ? await buyPrepare(rest, session, d)
          : op === "submit" ? await buySubmit(rest, session, d) : op === "result" ? await buyResult(rest, session, d)
          : { http: 400, body: { ok: false, code: "INVALID_INPUT" } };
        return reply(r.http, r.body);
      },
    },
  },
});
