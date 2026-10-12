// Server-to-server HMAC (separate secret from the MCP worker). Signs ts.nonce.scope.method.path.sha256(body).
// Replay protection is an in-memory nonce set: valid only with exactly ONE instance (see README).
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SKEW_MS = 5 * 60_000;
export const SCOPES = Object.freeze({ "/internal/v1/launch/prepare": "launch.prepare", "/internal/v1/launch/inspect": "launch.inspect" });

export function signRequest(secret, { ts, nonce, scope, method, path, body }) {
  const bh = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${ts}.${nonce}.${scope}.${method}.${path}.${bh}`).digest("hex");
}

export function createVerifier(secret, now = () => Date.now()) {
  const seen = new Map();
  return function verify({ headers, method, path, body }) {
    const ts = String(headers["x-mcpx-timestamp"] ?? ""), nonce = String(headers["x-mcpx-nonce"] ?? "");
    const scope = String(headers["x-mcpx-scope"] ?? ""), sig = String(headers["x-mcpx-signature"] ?? "");
    if (!/^\d{13}$/.test(ts) || !/^[0-9a-f-]{36}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return "bad_headers";
    if (SCOPES[path] !== scope) return "wrong_scope";
    const t = now();
    if (Math.abs(t - Number(ts)) > SKEW_MS) return "expired";
    const a = Buffer.from(signRequest(secret, { ts, nonce, scope, method, path, body }), "hex"), b = Buffer.from(sig, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad_signature";
    for (const [k, exp] of seen) if (exp < t) seen.delete(k);
    if (seen.has(nonce)) return "replayed";
    seen.set(nonce, t + 2 * SKEW_MS);
    return null;
  };
}
