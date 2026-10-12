// TEST ONLY: real Ed25519 keypairs generated in-process + in-memory store. Not real-wallet evidence.
import { describe, expect, it, beforeEach } from "vitest";
import { getAddressDecoder } from "@solana/addresses";
import {
  authorizeCreator, checkMutation, clearCookie, createChallenge, currentSession, readSessionCookie, sessionCookie, sha256, verifySignIn,
  CHALLENGE_TTL_MS, SESSION_COOKIE, type AuthStore, type ChallengeRow, type OwnedProduct,
} from "@/lib/creator-auth/core";

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { address: getAddressDecoder().decode(raw) as string, sign: async (m: string) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(m))) };
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const HOST = "mcpx.fun";

let challenges: Map<string, ChallengeRow & { consumed: boolean }>;
let sessions: Map<string, { wallet: string; expiresAt: string; revokedAt: string | null }>;
const store: AuthStore = {
  insertChallenge: async (r) => { challenges.set(r.nonceHash, { ...r, consumed: false }); },
  consumeChallenge: async (h) => { const c = challenges.get(h); if (!c || c.consumed) return null; c.consumed = true; return c; },
  insertSession: async (r) => { sessions.set(r.tokenHash, { wallet: r.wallet, expiresAt: r.expiresAt, revokedAt: null }); },
  getSession: async (h) => sessions.get(h) ?? null,
  revokeSession: async (h) => { const s = sessions.get(h); if (s) s.revokedAt = new Date().toISOString(); },
};
beforeEach(() => { challenges = new Map(); sessions = new Map(); });

async function signedIn(kp: Awaited<ReturnType<typeof keypair>>) {
  const c = await createChallenge(store, kp.address, HOST);
  if (!c.ok) throw new Error("challenge");
  return { c, sig: b64(await kp.sign(c.message)) };
}

describe("creator wallet sign-in (TEST ONLY keys)", () => {
  it("A01: valid signature over the server message creates a session for that wallet", async () => {
    const kp = await keypair();
    const { c, sig } = await signedIn(kp);
    expect(c.message).toContain(`${HOST} wants you to sign in with your Solana account:\n${kp.address}`);
    expect(c.message).toContain("Chain ID: mainnet");
    expect(c.message).toContain("not a transaction");
    const r = await verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: sig, host: HOST });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wallet).toBe(kp.address);
    expect([...sessions.keys()][0]).toBe(await sha256(r.token)); // only the hash is stored
    const req = new Request("https://mcpx.fun/x", { headers: { cookie: `${SESSION_COOKIE}=${r.token}` } });
    expect((await currentSession(store, req))?.wallet).toBe(kp.address);
  });

  it("A02: altered signature, other account, wrong domain, malformed input are denied", async () => {
    const kp = await keypair(), other = await keypair();
    const tries = [
      async () => { const { c, sig } = await signedIn(kp); const bad = sig.slice(0, 10) + (sig[10] === "A" ? "B" : "A") + sig.slice(11); return verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: bad, host: HOST }); },
      async () => { const { c } = await signedIn(kp); return verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: b64(await other.sign(c.message)), host: HOST }); },
      async () => { const { c, sig } = await signedIn(kp); return verifySignIn(store, { nonce: c.nonce, address: other.address, signature: sig, host: HOST }); },
      async () => { const { c, sig } = await signedIn(kp); return verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: sig, host: "www.mcpx.fun" }); },
      async () => { const { c } = await signedIn(kp); return verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: b64(await kp.sign(c.message.replace("mainnet", "devnet"))), host: HOST }); },
      async () => verifySignIn(store, { nonce: "x", address: kp.address, signature: "zz", host: HOST }),
      async () => verifySignIn(store, { nonce: "a".repeat(64), address: "not-an-address", signature: b64(new Uint8Array(64)), host: HOST }),
    ];
    for (const t of tries) expect((await t()).ok).toBe(false);
    expect(sessions.size).toBe(0);
    expect((await createChallenge(store, kp.address, "evil.example")).ok).toBe(false);
  });

  it("A03: expired challenge fails; concurrent replays — exactly one succeeds", async () => {
    const kp = await keypair();
    const { c, sig } = await signedIn(kp);
    const later = new Date(Date.now() + CHALLENGE_TTL_MS + 1000);
    expect((await verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: sig, host: HOST }, later)).ok).toBe(false);
    const fresh = await signedIn(kp);
    const rs = await Promise.all(Array.from({ length: 5 }, () => verifySignIn(store, { nonce: fresh.c.nonce, address: kp.address, signature: fresh.sig, host: HOST })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("A04: revoked and expired sessions fail closed; malformed cookies ignored", async () => {
    const kp = await keypair();
    const { c, sig } = await signedIn(kp);
    const r = await verifySignIn(store, { nonce: c.nonce, address: kp.address, signature: sig, host: HOST });
    if (!r.ok) throw new Error();
    const req = new Request("https://mcpx.fun/x", { headers: { cookie: `${SESSION_COOKIE}=${r.token}` } });
    expect(await currentSession(store, req, new Date(Date.now() + 25 * 3600_000))).toBeNull();
    await store.revokeSession(await sha256(r.token));
    expect(await currentSession(store, req)).toBeNull();
    expect(readSessionCookie(new Request("https://x", { headers: { cookie: `${SESSION_COOKIE}=../../etc` } }))).toBeNull();
  });

  it("A05: cookie is host-only HttpOnly Secure SameSite=Strict; CSRF guard rejects cross-site and header-less posts", () => {
    const ck = sessionCookie("t", 60);
    expect(ck.startsWith("__Host-")).toBe(true);
    for (const f of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(ck).toContain(f);
    expect(ck).not.toContain("Domain");
    expect(clearCookie()).toContain("Max-Age=0");
    const mk = (h: Record<string, string>, method = "POST") => new Request("https://mcpx.fun/api/auth/verify", { method, headers: { host: "mcpx.fun", ...h }, ...(method === "POST" ? { body: "{}" } : {}) });
    const good = { origin: "https://mcpx.fun", "content-type": "application/json", "x-mcpx-csrf": "1" };
    expect(checkMutation(mk(good))).toBeNull();
    expect(checkMutation(mk({ ...good, origin: "https://evil.example" }))).toBe("forbidden");
    expect(checkMutation(mk({ "content-type": "application/json", "x-mcpx-csrf": "1" }))).toBe("forbidden");
    expect(checkMutation(mk({ ...good, "x-mcpx-csrf": "" }))).toBe("forbidden");
    expect(checkMutation(mk({ ...good, "sec-fetch-site": "cross-site" }))).toBe("forbidden");
    expect(checkMutation(mk({ ...good, "content-type": "text/plain" }))).toBe("unsupported_media_type");
    expect(checkMutation(mk({ ...good, "content-length": "5000" }))).toBe("too_large");
    expect(checkMutation(mk(good, "GET"))).toBe("method_not_allowed");
  });

  it("A06: challenge store outage propagates (route returns 503, never a session)", async () => {
    const kp = await keypair();
    const broken: AuthStore = { ...store, consumeChallenge: async () => { throw new Error("db down"); } };
    const { c, sig } = await signedIn(kp);
    await expect(verifySignIn(broken, { nonce: c.nonce, address: kp.address, signature: sig, host: HOST })).rejects.toThrow();
    expect(sessions.size).toBe(0);
  });

  it("K01/K02: only the verified on-chain creator may manage; other wallets, unknown, suspended and config-less products denied", async () => {
    const owner = (await keypair()).address, other = (await keypair()).address;
    const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "bbbbbbbb-0000-4000-8000-00000000000b", S = "cccccccc-0000-4000-8000-00000000000c", N = "dddddddd-0000-4000-8000-00000000000d";
    const rows: Record<string, OwnedProduct> = {
      [A]: { creationId: A, creatorWallet: owner, lifecycleState: "active" },
      [B]: { creationId: B, creatorWallet: other, lifecycleState: "active" },
      [S]: { creationId: S, creatorWallet: owner, lifecycleState: "suspended" },
      [N]: { creationId: N, creatorWallet: owner, lifecycleState: null },
    };
    const os = { getProduct: async (id: string) => rows[id] ?? null };
    expect(await authorizeCreator(os, owner, A)).toBe(true);
    expect(await authorizeCreator(os, other, A)).toBe(false);
    expect(await authorizeCreator(os, owner, B)).toBe(false);
    expect(await authorizeCreator(os, owner, S)).toBe(false);
    expect(await authorizeCreator(os, owner, N)).toBe(false);
    expect(await authorizeCreator(os, owner, "eeeeeeee-0000-4000-8000-00000000000e")).toBe(false);
    expect(await authorizeCreator(os, owner, "slug-a")).toBe(false);
  });
});

describe("SIWS message format (wallet compatibility)", () => {
  it("nonce is alphanumeric and every field line matches the SIWS grammar", async () => {
    const { createChallenge } = await import("@/lib/creator-auth/core");
    const kp = await makeKeypair();
    const c = await createChallenge(store, kp.address, HOST);
    if (!c.ok) throw new Error("challenge failed");
    expect(c.nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
    const lines = c.message.split("\n");
    expect(lines[0]).toBe(`${HOST} wants you to sign in with your Solana account:`);
    expect(lines[1]).toBe(kp.address);
    expect(lines.slice(5)).toEqual([
      expect.stringMatching(/^URI: https?:\/\/\S+$/),
      "Version: 1",
      "Chain ID: mainnet",
      `Nonce: ${c.nonce}`,
      expect.stringMatching(/^Issued At: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      expect.stringMatching(/^Expiration Time: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    ]);
  });
});

