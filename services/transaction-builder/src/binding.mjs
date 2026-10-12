// Candidate binding: every launch-relevant value plus the exact message hash, MAC'd with the builder
// secret. Changing creator, mint, quote, recipients, bps, buy amount, slippage or blockhash breaks it.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const BINDING_SCHEMA = "mcpx.launch.binding.v1";
export const CANDIDATE_TTL_MS = 60_000; // blockhashes age out fast; stale candidates must be re-prepared

export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
export const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
export const macBinding = (secret, binding) => createHmac("sha256", secret).update(`${BINDING_SCHEMA}.${canonical(binding)}`).digest("hex");

export function verifyBindingMac(secret, binding, mac) {
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const a = Buffer.from(macBinding(secret, binding), "hex"), b = Buffer.from(mac, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
