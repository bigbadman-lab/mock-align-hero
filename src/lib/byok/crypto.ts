// L7-A BYOK envelope encryption (server-only). AES-256-GCM via WebCrypto (works on workerd and Node).
// The key-encryption keyring comes from a server secret (MCPX_BYOK_KEYRING), never the DB or the browser.
// Format: "v2:<base64 32 bytes>,v1:<base64 32 bytes>" — the first entry encrypts; all entries can decrypt (rotation).
// AAD binds every ciphertext to its product + credential idempotency ref, so a row copied to another product fails to decrypt.

export const ALG = "AES-256-GCM" as const;
type Bytes = Uint8Array<ArrayBuffer>;
export interface Sealed { iv: Bytes; ciphertext: Bytes; kekVersion: string; alg: typeof ALG }
export interface Keyring { active: string; keys: Map<string, CryptoKey> }

export class ByokCryptoError extends Error {
  constructor(public code: "keyring_missing" | "keyring_invalid" | "unknown_key_version" | "decrypt_failed" | "invalid_input") { super(code); }
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function parseKeyring(raw: string | undefined | null): Promise<Keyring> {
  if (!raw || !raw.trim()) throw new ByokCryptoError("keyring_missing");
  const keys = new Map<string, CryptoKey>();
  let active = "";
  for (const part of raw.split(",")) {
    const m = /^(v[0-9]{1,4}):([A-Za-z0-9+/]{43}=)$/.exec(part.trim());
    if (!m) throw new ByokCryptoError("keyring_invalid");
    const bytes = b64(m[2]!);
    if (bytes.length !== 32 || keys.has(m[1]!)) throw new ByokCryptoError("keyring_invalid");
    keys.set(m[1]!, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]));
    if (!active) active = m[1]!;
  }
  return { active, keys };
}

export const aadFor = (creationId: string, credentialRef: string) => new TextEncoder().encode(`mcpx-byok:${creationId}:${credentialRef}`);

export async function seal(ring: Keyring, plaintext: string, aad: Bytes): Promise<Sealed> {
  if (!plaintext || plaintext.length > 512) throw new ByokCryptoError("invalid_input");
  const key = ring.keys.get(ring.active);
  if (!key) throw new ByokCryptoError("keyring_missing");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(plaintext));
  return { iv, ciphertext: new Uint8Array(ct), kekVersion: ring.active, alg: ALG };
}

/** Fails closed: unknown key version, wrong AAD, tampered or malformed data all throw a generic error. */
export async function open(ring: Keyring, s: Sealed, aad: Bytes): Promise<string> {
  if (s.alg !== ALG || !(s.iv instanceof Uint8Array) || s.iv.length !== 12 || !(s.ciphertext instanceof Uint8Array) || s.ciphertext.length < 17) throw new ByokCryptoError("decrypt_failed");
  const key = ring.keys.get(s.kekVersion);
  if (!key) throw new ByokCryptoError("unknown_key_version");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv, additionalData: aad }, key, s.ciphertext);
    return new TextDecoder().decode(pt);
  } catch { throw new ByokCryptoError("decrypt_failed"); }
}
