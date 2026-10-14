import { describe, it, expect } from "vitest";
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram, PublicKey, AddressLookupTableAccount } from "@solana/web3.js";
import { SESSION_TTL_MS } from "@/lib/creator-auth/core";
import { gatePrepareDraft, gateVerify, modeFor, type GateDeps, type BuilderCall } from "@/lib/tx-builder/launch-gate";
import { NATIVE_SOL, type RehearsalDeps, type RehearsalPermission } from "@/lib/tx-builder/rehearsal";
import { checkAltUse } from "@/lib/launch/alt-check";
import { buyPrepare, buySubmit, buyStatus, type BuyDeps } from "@/lib/launch/rehearsal-buy";
import { b64 } from "@/lib/launch/tx-wire";

const k = () => Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;
const me = k(), other = k(), ops = k(), plat = k(), deployer = k(), mcp = k();
const mint = k();
const DRAFT = "3f8a2b1c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const fresh = (wallet = me, ageMs = 60_000) => ({ wallet, expiresAt: new Date(NOW - ageMs + SESSION_TTL_MS).toISOString() });
const draft = { id: DRAFT, revision: 2, templateId: "wallet-inspector", name: "Child", symbol: "CHD", uri: "https://mcpx.fun/m.json" };
const sh = (c: string) => [{ address: c, bps: 6000 }, { address: ops, bps: 2500 }, { address: plat, bps: 1500 }];
const okChecks = { payerIsCreator: true, signersExactlyCreatorAndMint: true, feeSharesExact: true };

function rehearsal(p: RehearsalPermission | null, log: string[] = [], over: Partial<RehearsalDeps> = {}): RehearsalDeps {
  return { enabled: true, configuredCreator: me, permission: async () => p,
    reserve: async (_w, d, m) => { log.push(`reserve:${d}:${m}`); return p?.status === "AVAILABLE" ? "reserved" : "already_reserved"; },
    submit: async () => "submitted", ...over };
}
const avail: RehearsalPermission = { status: "AVAILABLE", creatorWallet: me, draftId: null, mint: null, signature: null };
const reserved: RehearsalPermission = { status: "RESERVED", creatorWallet: me, draftId: DRAFT, mint, signature: null };

function deps(over: Partial<GateDeps> = {}, calls: any[] = []): GateDeps {
  const builder: BuilderCall = async (op, body: any) => {
    calls.push([op, body]);
    if (op === "prepare") return { status: 200, body: { status: "UNSIGNED_CANDIDATE", messageBase64: "AA==", binding: { creator: body.creator, mint: body.mint, quoteMint: body.rehearsal === "SOL" ? NATIVE_SOL : mcp, ...(body.rehearsal ? { rehearsal: "SOL" } : {}), shareholders: sh(body.creator), name: draft.name, symbol: draft.symbol, uri: draft.uri }, bindingMac: "m" } };
    return { status: 200, body: { valid: true, checks: okChecks } };
  };
  return { config: { enabled: false, signingEnabled: false, opsRecipient: ops, platformRecipient: plat, nativeDeployer: deployer }, builder, now: () => NOW,
    canonicalMint: async () => mcp, loadDraft: async (w) => (w === me || w === other ? draft : null), checkMetadata: async () => null, checkAlt: async () => null, ...over };
}
const prep = { draftId: DRAFT, revision: 2, mint, idempotencyKey: "0b7c8d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", connectedWallet: me };

describe("rehearsal wallet authorization", () => {
  it("approved wallet prepares a SOL-quote launch and reserves the permission before signing", async () => {
    const calls: any[] = [], log: string[] = [];
    const r = await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal(avail, log) }, calls));
    expect(r.http).toBe(200);
    expect(r.body["quoteMint"]).toBe(NATIVE_SOL);
    expect(calls[0][1].rehearsal).toBe("SOL");
    expect(calls[0][1].creator).toBe(me);
    expect(log).toEqual([`reserve:${DRAFT}:${mint}`]);
  });
  it("any other wallet stays on the normal (closed) $MCP path and never reaches SOL", async () => {
    const calls: any[] = [];
    const r = await gatePrepareDraft({ ...prep, connectedWallet: other }, fresh(other), deps({ rehearsal: rehearsal(avail) }, calls));
    expect(r.body["code"]).toBe("CHILD_LAUNCH_NOT_ENABLED");
    expect(calls).toEqual([]);
  });
  it("requires a session, and a fresh one", async () => {
    expect((await gatePrepareDraft(prep, null, deps({ rehearsal: rehearsal(avail) }))).body["code"]).toBe("CHILD_LAUNCH_NOT_ENABLED");
    expect((await gatePrepareDraft(prep, fresh(me, 11 * 60_000), deps({ rehearsal: rehearsal(avail) }))).body["code"]).toBe("LAUNCH_REAUTH_REQUIRED");
  });
  it("switch off or no permission row: no rehearsal", async () => {
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: { ...rehearsal(avail), enabled: false } }))).body["code"]).toBe("CHILD_LAUNCH_NOT_ENABLED");
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal(null) }))).body["code"]).toBe("REHEARSAL_NOT_PERMITTED");
  });
  it("deployer / ops / platform wallets can never be the rehearsal creator", async () => {
    for (const w of [deployer, ops, plat]) {
      const m = await modeFor(fresh(w), deps({ rehearsal: { ...rehearsal({ ...avail, creatorWallet: w }), configuredCreator: w } }));
      expect(m).toEqual({ kind: "blocked", code: "REHEARSAL_CREATOR_PROHIBITED" });
    }
  });
  it("a browser-supplied creator override is refused", async () => {
    expect((await gatePrepareDraft({ ...prep, creator: other }, fresh(), deps({ rehearsal: rehearsal(avail) }))).body["code"]).toBe("CREATOR_WALLET_MISMATCH");
  });
});

describe("duplicate attempts and recovery", () => {
  it("retry with the same mint after a declined signature reuses the reservation", async () => {
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal(reserved) }))).http).toBe(200);
  });
  it("a different mint while reserved is refused (no second launch)", async () => {
    expect((await gatePrepareDraft({ ...prep, mint: k() }, fresh(), deps({ rehearsal: rehearsal(reserved) }))).body["code"]).toBe("REHEARSAL_BUSY");
  });
  it("submitted or used permission cannot launch again", async () => {
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal({ ...reserved, status: "SUBMITTED", signature: "x" }) }))).body["code"]).toBe("REHEARSAL_ALREADY_SUBMITTED");
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal({ ...reserved, status: "CONSUMED" }) }))).body["code"]).toBe("REHEARSAL_USED");
  });
  it("permission store outage fails closed", async () => {
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal(avail, [], { permission: async () => { throw new Error("x"); } }) }))).body["code"]).toBe("REHEARSAL_UNAVAILABLE");
  });
});

describe("transaction security before signing", () => {
  const vin = (b: any = {}) => ({ messageBase64: "AA==", bindingMac: "m", connectedWallet: me, draftId: DRAFT, revision: 2,
    binding: { creator: me, mint, quoteMint: NATIVE_SOL, rehearsal: "SOL", shareholders: sh(me), name: draft.name, symbol: draft.symbol, uri: draft.uri, ...b } });
  it("verified reserved candidate is launch-ready", async () => {
    const r = await gateVerify(vin(), fresh(), deps({ rehearsal: rehearsal(reserved) }));
    expect(r.http).toBe(200);
    expect(r.body["launchReady"]).toBe(true);
  });
  it("tampered quote, shares, or missing rehearsal marker are refused", async () => {
    const d = deps({ rehearsal: rehearsal(reserved) });
    expect((await gateVerify(vin({ quoteMint: mcp }), fresh(), d)).body["code"]).toBe("QUOTE_MINT_NOT_CANONICAL");
    expect((await gateVerify(vin({ shareholders: sh(other) }), fresh(), d)).body["code"]).toBe("SHARES_MISMATCH");
    expect((await gateVerify(vin({ rehearsal: undefined }), fresh(), d)).body["code"]).toBe("REHEARSAL_SCOPE_MISMATCH");
  });
  it("candidate for a mint other than the reserved one is refused", async () => {
    expect((await gateVerify(vin({ mint: k() }), fresh(), deps({ rehearsal: rehearsal(reserved) }))).body["code"]).toBe("REHEARSAL_RESERVED_FOR_OTHER_ATTEMPT");
  });
  it("unavailable lookup table blocks before signing", async () => {
    expect((await gateVerify(vin(), fresh(), deps({ rehearsal: rehearsal(reserved), checkAlt: async () => "ALT_UNAVAILABLE" }))).body["code"]).toBe("ALT_UNAVAILABLE");
    expect((await gatePrepareDraft(prep, fresh(), deps({ rehearsal: rehearsal(avail), checkAlt: undefined }))).body["code"]).toBe("ALT_CHECK_UNAVAILABLE");
  });
});

describe("normal $MCP launch isolation", () => {
  it("prelaunch: normal launches stay closed even with the rehearsal switched on", async () => {
    expect((await gatePrepareDraft({ ...prep, connectedWallet: other }, fresh(other), deps({ rehearsal: rehearsal(avail) }))).body["code"]).toBe("CHILD_LAUNCH_NOT_ENABLED");
  });
  it("a normal launch never accepts a SOL-scoped binding", async () => {
    const d = deps({ config: { enabled: true, signingEnabled: true, opsRecipient: ops, platformRecipient: plat, nativeDeployer: deployer } });
    const r = await gateVerify({ messageBase64: "AA==", bindingMac: "m", connectedWallet: other, binding: { creator: other, mint, quoteMint: mcp, rehearsal: "SOL", shareholders: sh(other) } }, fresh(other), d);
    expect(r.body["code"]).toBe("REHEARSAL_SCOPE_MISMATCH");
  });
  it("a normal launch with no canonical mint fails closed and never falls back to SOL", async () => {
    const calls: any[] = [];
    const d = deps({ config: { enabled: true, opsRecipient: ops, platformRecipient: plat, nativeDeployer: deployer }, canonicalMint: async () => null }, calls);
    expect((await gatePrepareDraft({ ...prep, connectedWallet: other }, fresh(other), d)).body["code"]).toBe("CANONICAL_MINT_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });
});

describe("lookup table check", () => {
  const payer = Keypair.generate().publicKey, altKey = Keypair.generate().publicKey;
  const addrs = Array.from({ length: 13 }, () => Keypair.generate().publicKey);
  const altData = (deactivated: boolean, n = 13) => {
    const d = new Uint8Array(56 + 32 * n); const v = new DataView(d.buffer);
    v.setUint32(0, 1, true); v.setBigUint64(4, deactivated ? 5n : 0xffffffffffffffffn, true);
    return d;
  };
  const msg = () => {
    const alt = new AddressLookupTableAccount({ key: altKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs } });
    const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: addrs[12]!, lamports: 1 });
    return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: new PublicKey(addrs[0]!).toBase58(), instructions: [ix] }).compileToV0Message([alt])).message.serialize();
  };
  const owner = "AddressLookupTab1e1111111111111111111111111";
  it("passes for an active table holding every used index", () => expect(checkAltUse(msg(), 2, altKey.toBase58(), { owner, data: altData(false) })).toBeNull());
  it("fails closed when unavailable, deactivated, short, or not the configured table", () => {
    expect(checkAltUse(msg(), 2, altKey.toBase58(), null)).toBe("ALT_UNAVAILABLE");
    expect(checkAltUse(msg(), 2, altKey.toBase58(), { owner, data: altData(true) })).toBe("ALT_DEACTIVATED");
    expect(checkAltUse(msg(), 2, altKey.toBase58(), { owner, data: altData(false, 5) })).toBe("ALT_INSUFFICIENT");
    expect(checkAltUse(msg(), 2, k(), { owner, data: altData(false) })).toBe("ALT_NOT_USED");
    expect(checkAltUse(msg(), 2, null, null)).toBe("ALT_NOT_CONFIGURED");
  });
  it("rejects a transaction over 1,232 bytes", () => expect(checkAltUse(new Uint8Array(1200), 2, altKey.toBase58(), null)).toBe("TX_TOO_LARGE"));
});

describe("optional 0.05 SOL initial buy (separate transaction)", () => {
  const kp = Keypair.generate(), W = kp.publicKey.toBase58();
  const submitted: RehearsalPermission = { status: "SUBMITTED", creatorWallet: W, draftId: DRAFT, mint, signature: "s" };
  const buyMsg = () => new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: k(), instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(mint), lamports: 1 })] }).compileToV0Message();
  const m = buyMsg();
  const sent: string[] = [];
  const bd = (p: RehearsalPermission = submitted, verified = true): BuyDeps => ({
    rehearsal: { ...rehearsal(p), configuredCreator: W }, now: () => NOW,
    builder: async (op, body: any) => op === "status"
      ? { status: 200, body: { state: verified ? "CREATED_FEE_VERIFIED" : "NOT_FOUND" } }
      : { status: 200, body: { status: "UNSIGNED_BUY_CANDIDATE", messageBase64: b64.enc(m.serialize()), evidence: { quotedTokens: "123", simulation: { status: "PASS" } }, _q: body.quoteAmount } },
    mac: async (s) => `mac:${s.length}:${s.slice(0, 60)}`, send: async (t) => { sent.push(t); return { ok: true }; }, result: async () => ({ state: "confirmed", tokensReceived: "123" }),
  });
  const s = fresh(W);
  it("is offered only after the creation is confirmed with verified fees", async () => {
    expect((await buyStatus({ connectedWallet: W }, s, bd(submitted, false))).body["verified"]).toBe(false);
    expect((await buyStatus({ connectedWallet: W }, s, bd())).body["verified"]).toBe(true);
    expect((await buyPrepare({ connectedWallet: W }, s, bd({ ...submitted, status: "RESERVED" }))).body["code"]).toBe("CREATION_NOT_SUBMITTED");
  });
  it("prepares exactly 0.05 SOL for the permitted mint", async () => {
    const r = await buyPrepare({ connectedWallet: W }, s, bd());
    expect(r.body["quoteLamports"]).toBe("50000000");
    expect(r.body["mint"]).toBe(mint);
  });
  it("buy declined: nothing is sent; tampered or altered buys are refused", async () => {
    sent.length = 0;
    const d = bd();
    const p = (await buyPrepare({ connectedWallet: W }, s, d)).body as any;
    const tx = new VersionedTransaction(m); tx.sign([kp]);
    const signed = b64.enc(tx.serialize());
    expect((await buySubmit({ connectedWallet: W, ...p, mac: "forged", signedTxBase64: signed }, s, d)).body["code"]).toBe("BUY_TAMPERED");
    const other = new VersionedTransaction(buyMsg()); other.sign([kp]);
    expect((await buySubmit({ connectedWallet: W, ...p, signedTxBase64: b64.enc(other.serialize()) }, s, d)).body["code"]).toBe("MESSAGE_ALTERED");
    expect(sent).toEqual([]);
    expect((await buySubmit({ connectedWallet: W, ...p, signedTxBase64: signed }, s, d)).http).toBe(202);
    expect(sent.length).toBe(1);
  });
  it("buy broadcast failure leaves the launch alone (no creation retry)", async () => {
    const d = { ...bd(), send: async () => ({ ok: false, detail: "insufficient" }) };
    const p = (await buyPrepare({ connectedWallet: W }, s, d)).body as any;
    const tx = new VersionedTransaction(m); tx.sign([kp]);
    expect((await buySubmit({ connectedWallet: W, ...p, signedTxBase64: b64.enc(tx.serialize()) }, s, d)).body["code"]).toBe("BROADCAST_FAILED");
  });
  it("other wallets can never buy through the rehearsal path", async () => {
    expect((await buyPrepare({ connectedWallet: other }, fresh(other), bd())).body["code"]).toBe("REHEARSAL_NOT_PERMITTED");
  });
});
