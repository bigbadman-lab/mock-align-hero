// Server-only HMAC client for the transaction builder (mirrors services/transaction-builder/src/auth.mjs).
// Uses WebCrypto so it runs on workerd. The secret never leaves the server.
import type { BuilderCall, GateConfig } from "./launch-gate";

const SCOPE = { prepare: "launch.prepare", inspect: "launch.inspect", "prepare-buy": "launch.prepare_buy", status: "launch.status" } as const;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const pk = (v: string | undefined) => (v && B58.test(v) ? v : null);

export function gateConfig(): GateConfig {
  return {
    enabled: process.env["MCPX_CHILD_LAUNCH_ENABLED"] === "1",
    // Second, separate switch: lets the creator's wallet sign and the site broadcast real launches.
    signingEnabled: process.env["MCPX_CHILD_LAUNCH_SIGNING"] === "1",
    opsRecipient: pk(process.env["MCPX_FEE_OPS_RECIPIENT"]),
    platformRecipient: pk(process.env["MCPX_FEE_PLATFORM_RECIPIENT"]),
    nativeDeployer: pk(process.env["MCPX_NATIVE_DEPLOYER_PUBLIC_KEY"]),
  };
}

export const builderCall: BuilderCall = async (op, payload) => {
  const url = process.env["MCPX_TX_BUILDER_URL"], secret = process.env["MCPX_TX_BUILDER_SECRET"];
  if (!url || !/^https:\/\//.test(url) || !secret) throw new Error("builder not configured");
  const path = `/internal/v1/launch/${op}`, body = JSON.stringify(payload);
  const ts = String(Date.now()), nonce = crypto.randomUUID(), scope = SCOPE[op];
  const enc = new TextEncoder();
  const bh = hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${nonce}.${scope}.POST.${path}.${bh}`)));
  const r = await fetch(new URL(path, url), {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-mcpx-timestamp": ts, "x-mcpx-nonce": nonce, "x-mcpx-scope": scope, "x-mcpx-signature": sig },
  });
  const text = await r.text();
  if (text.length > 256_000) throw new Error("oversized");
  return { status: r.status, body: JSON.parse(text) };
};
