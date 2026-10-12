// Creator wallet sign-in (Sign In With Solana-style off-chain message). Pure logic with an injectable store.
// A connected wallet is NOT a session; a session is NOT authority over a product (see authorizeCreator).
import { getAddressEncoder, isAddress } from "@solana/addresses";

export const SESSION_COOKIE = "__Host-mcpx_creator";
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 24 * 3600_000;
export const MAX_AUTH_BODY = 2048;
export const ALLOWED_HOSTS = [
  "mcpx.fun",
  "www.mcpx.fun",
  "mock-align-hero.lovable.app",
  "id-preview--aefb2b2b-11b5-4651-8a65-1a111dab9c2f.lovable.app",
  "localhost:8080",
];

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const isSolanaAddress = (a: unknown): a is string => typeof a === "string" && a.length >= 32 && a.length <= 44 && isAddress(a);

/** Exact text the wallet signs. Built only by the server; the browser cannot choose it. */
export function buildMessage(p: { domain: string; address: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  const scheme = p.domain.startsWith("localhost") ? "http" : "https";
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.address,
    "",
    "Sign in to manage MCP products on MCPX. This is an off-chain message, not a transaction: it cannot move funds and costs nothing.",
    "",
    `URI: ${scheme}://${p.domain}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join("\n");
}

export async function verifyEd25519(address: string, message: string, signature: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false;
  try {
    const pub = new Uint8Array(getAddressEncoder().encode(address as Parameters<ReturnType<typeof getAddressEncoder>["encode"]>[0]));
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export interface ChallengeRow { wallet: string; domain: string; message: string; expiresAt: string }
export interface SessionRow { wallet: string; expiresAt: string; revokedAt: string | null }
export interface AuthStore {
  insertChallenge(row: ChallengeRow & { nonceHash: string }): Promise<void>;
  /** Atomically marks an unconsumed challenge consumed and returns it; null if missing or already used. */
  consumeChallenge(nonceHash: string): Promise<ChallengeRow | null>;
  insertSession(row: { tokenHash: string; wallet: string; expiresAt: string }): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRow | null>;
  revokeSession(tokenHash: string): Promise<void>;
}

export async function createChallenge(store: AuthStore, address: string, host: string, now = new Date()) {
  if (!ALLOWED_HOSTS.includes(host) || !isSolanaAddress(address)) return { ok: false as const, error: "invalid_input" };
  const nonce = randomToken(); // 256 bits
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const message = buildMessage({ domain: host, address, nonce, issuedAt: now, expiresAt });
  await store.insertChallenge({ nonceHash: await sha256(nonce), wallet: address, domain: host, message, expiresAt: expiresAt.toISOString() });
  return { ok: true as const, nonce, message };
}

const b64ToBytes = (s: string) => {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(s)) return null;
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch { return null; }
};

/** Consumes the challenge first (single use even on failure), then checks wallet, domain, expiry and signature. */
export async function verifySignIn(store: AuthStore, p: { nonce: string; address: string; signature: string; host: string }, now = new Date()) {
  const deny = { ok: false as const, error: "sign_in_failed" };
  if (typeof p.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(p.nonce) || !isSolanaAddress(p.address) || !ALLOWED_HOSTS.includes(p.host)) return deny;
  const sig = typeof p.signature === "string" ? b64ToBytes(p.signature) : null;
  if (!sig) return deny;
  const ch = await store.consumeChallenge(await sha256(p.nonce));
  if (!ch) return deny;
  if (new Date(ch.expiresAt).getTime() <= now.getTime()) return deny;
  if (ch.wallet !== p.address || ch.domain !== p.host) return deny;
  if (!ch.message.includes(`\nNonce: ${p.nonce}\n`)) return deny;
  if (!(await verifyEd25519(ch.wallet, ch.message, sig))) return deny;
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await store.insertSession({ tokenHash: await sha256(token), wallet: ch.wallet, expiresAt: expiresAt.toISOString() });
  return { ok: true as const, token, wallet: ch.wallet, expiresAt: expiresAt.toISOString() };
}

export function readSessionCookie(request: Request): string | null {
  const c = request.headers.get("cookie") ?? "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) { const t = v.join("="); return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; }
  }
  return null;
}

/** Current session wallet, or null. Store errors propagate (callers fail closed). */
export async function currentSession(store: AuthStore, request: Request, now = new Date()) {
  const token = readSessionCookie(request);
  if (!token) return null;
  const s = await store.getSession(await sha256(token));
  if (!s || s.revokedAt || new Date(s.expiresAt).getTime() <= now.getTime()) return null;
  return { wallet: s.wallet, expiresAt: s.expiresAt, token };
}

export const sessionCookie = (token: string, maxAgeSec: number) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** CSRF + shape guard for cookie-authenticated mutations. Returns an error code or null. */
export function checkMutation(request: Request): string | null {
  if (request.method !== "POST") return "method_not_allowed";
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? "";
  if (!origin || !ALLOWED_HOSTS.includes(host)) return "forbidden";
  try { if (new URL(origin).host !== host) return "forbidden"; } catch { return "forbidden"; }
  if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return "forbidden";
  if (request.headers.get("x-mcpx-csrf") !== "1") return "forbidden";
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return "unsupported_media_type";
  if (Number(request.headers.get("content-length") ?? "0") > MAX_AUTH_BODY) return "too_large";
  return null;
}

// ---- Creator authorization (every request) ----
export interface OwnedProduct { creationId: string; creatorWallet: string; lifecycleState: "inactive" | "active" | "suspended" | null }
export interface OwnershipStore { getProduct(creationId: string): Promise<OwnedProduct | null> }

/** Session wallet must equal the verified on-chain creator recorded on the creation; suspended or config-less products are denied. */
export async function authorizeCreator(store: OwnershipStore, sessionWallet: string, creationId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(creationId)) return false;
  const p = await store.getProduct(creationId);
  if (!p || p.creatorWallet !== sessionWallet) return false;
  return p.lifecycleState === "active" || p.lifecycleState === "inactive";
}
