// Product access keys: format, keyed verifier, and per-request authorization (injectable store).
// Plaintext keys exist only in memory at issuance and in the caller's Authorization header; only the verifier is stored.
import { hmac } from "@/lib/tools/relay";

export const KEY_PREFIX = "mcpx_pk_";
const KEY_RE = /^mcpx_pk_[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url, no padding

export const isWellFormedProductKey = (t: string) => KEY_RE.test(t);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Audience-bound verifier: the creation ID is inside the MAC, so a key for A can never match a lookup for B. */
export const keyVerifier = (pepper: string, creationId: string, token: string) => hmac(pepper, `mcpx-product-key:v1|${creationId}|${token}`);

export async function generateProductKey(pepper: string, creationId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = KEY_PREFIX + b64url(bytes);
  return { plaintext, verifier: await keyVerifier(pepper, creationId, plaintext), displayPrefix: plaintext.slice(0, KEY_PREFIX.length + 4) };
}

export interface StoredKey { keyId: string; creationId: string; status: "active" | "revoked"; expiresAt: string | null; revokedAt: string | null }
export interface KeyStore { findByVerifier(verifier: string): Promise<StoredKey | null> }

export function readPepper(): string | null {
  const p = process.env["MCPX_PRODUCT_KEY_PEPPER"];
  return p && p.length >= 32 ? p : null;
}

/** Checked on every request; no cache, so revocation/expiry apply on the next request. Store errors propagate (fail closed). */
export async function authorizeProductKey(store: KeyStore, pepper: string, creationId: string, token: string, now = new Date()): Promise<boolean> {
  if (!isWellFormedProductKey(token)) return false;
  const k = await store.findByVerifier(await keyVerifier(pepper, creationId, token));
  if (!k || k.creationId !== creationId || k.status !== "active" || k.revokedAt) return false;
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}
