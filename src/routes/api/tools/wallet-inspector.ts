// Same-origin bounded proxy: browser → here → signed request → Render worker → Helius.
// Never forwards caller URLs/methods/networks. Never logs addresses, bodies or secrets.
import { createFileRoute } from "@tanstack/react-router";
import { WI_SCHEMA, WI_TOOL_ID, isValidSolanaAddress, isWalletInspectorResult } from "@/lib/tools/wallet-inspector";

const MAX_BODY = 256;
const WORKER_TIMEOUT_MS = 25_000;
const READY_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 1_500_000;
// Disclosed limits (enforced in the shared database counter, so they hold across all server instances).
export const LIMITS = { perVisitorPerMinute: 6, perVisitorPerHour: 40, globalPerMinute: 60 };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function config() {
  const url = process.env["MCPX_WORKER_URL"]?.replace(/\/+$/, "");
  const secret = process.env["MCPX_WORKER_SECRET"];
  return url && url.startsWith("https://") && secret && secret.length >= 32 ? { url, secret } : null;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

async function take(bucket: string, windowSeconds: number, limit: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("mcpx_rate_limit_take", { _bucket: bucket, _window_seconds: windowSeconds, _limit: limit });
  if (error) throw new Error("rate limiter unavailable");
  return data === true;
}

export const Route = createFileRoute("/api/tools/wallet-inspector")({
  server: {
    handlers: {
      // Availability only: is the worker configured and reporting ready? No secrets returned.
      GET: async () => {
        const cfg = config();
        if (!cfg) return json(200, { available: false, reason: "not_configured" });
        try {
          const r = await fetch(`${cfg.url}/ready`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
          return json(200, r.ok ? { available: true, limits: LIMITS } : { available: false, reason: "worker_not_ready" });
        } catch {
          return json(200, { available: false, reason: "worker_unreachable" });
        }
      },
      POST: async ({ request }) => {
        const cfg = config();
        if (!cfg) return json(503, { error: "unavailable" });
        if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json(415, { error: "invalid_input" });
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json(413, { error: "invalid_input" });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_input" }); }
        const b = body as Record<string, unknown> | null;
        if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).join(",") !== "address" || typeof b["address"] !== "string" || !isValidSolanaAddress(b["address"])) {
          return json(400, { error: "invalid_input" });
        }
        const address = b["address"];

        const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        const visitor = (await hmac(cfg.secret, `ip:${ip}`)).slice(0, 32); // opaque; raw IP never stored
        try {
          const ok = (await take(`wi:m:${visitor}`, 60, LIMITS.perVisitorPerMinute))
            && (await take(`wi:h:${visitor}`, 3600, LIMITS.perVisitorPerHour))
            && (await take("wi:global", 60, LIMITS.globalPerMinute));
          if (!ok) return json(429, { error: "rate_limited" });
        } catch {
          return json(503, { error: "unavailable" }); // fail closed: no limiter, no execution
        }

        const payload = JSON.stringify({ schema: WI_SCHEMA, toolId: WI_TOOL_ID, input: { address } });
        const ts = String(Date.now());
        const nonce = crypto.randomUUID();
        const sig = await hmac(cfg.secret, `${ts}.${nonce}.${payload}`);
        let res: Response;
        try {
          res = await fetch(`${cfg.url}/internal/v1/tools/execute`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-mcpx-timestamp": ts, "x-mcpx-nonce": nonce, "x-mcpx-signature": sig },
            body: payload,
            signal: AbortSignal.any([AbortSignal.timeout(WORKER_TIMEOUT_MS), request.signal]),
          });
        } catch {
          return json(504, { error: "timeout" });
        }
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) return json(502, { error: "too_large" });
        let out: unknown;
        try { out = JSON.parse(text); } catch { return json(502, { error: "bad_response" }); }
        if (!res.ok) {
          const k = (out as { error?: unknown })?.error;
          const allowed = ["rate_limited", "busy", "timeout", "provider_error", "too_large", "bad_response", "invalid_input"];
          return json(res.status === 429 ? 429 : 502, { error: typeof k === "string" && allowed.includes(k) ? k : "provider_error" });
        }
        if (!isWalletInspectorResult(out, address)) return json(502, { error: "bad_response" });
        console.log(JSON.stringify({ tool: WI_TOOL_ID, executionId: out.executionId, partial: out.partial, holdings: out.tokenHoldings.length }));
        return json(200, out);
      },
    },
  },
});
