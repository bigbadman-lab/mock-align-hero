import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { bindLaunchCreator, checkCandidateBinding, type BindingContext } from "@/lib/tx-builder/creator-binding";

const k = () => Keypair.generate().publicKey.toBase58();
const me = k(), ops = k(), plat = k(), deployer = k(), mint = k();
const ctx: BindingContext = { sessionWallet: me, connectedWallet: me, nativeDeployer: deployer, opsRecipient: ops, platformRecipient: plat };
const body = { idempotencyKey: "launch-0001", mint, name: "Child", symbol: "CHD", uri: "https://mcpx.fun/m.json", initialBuy: null, format: "v0_alt" as const };
const good = { feePayer: me, signers: [me, mint], mint, shareholders: [{ address: me, bps: 6000 }, { address: ops, bps: 2500 }, { address: plat, bps: 1500 }] };

describe("CREATOR_RECIPIENT_BINDING", () => {
  it("60% creator comes from the signed-in session, not the browser", () => {
    const r = bindLaunchCreator(body, ctx);
    expect(r).toMatchObject({ ok: true, request: { creator: me } });
    expect(bindLaunchCreator({ ...body, creator: me }, ctx)).toMatchObject({ ok: true, request: { creator: me } });
  });
  it("refuses wallet substitution in the request body", () => {
    expect(bindLaunchCreator({ ...body, creator: k() }, ctx)).toEqual({ ok: false, code: "CREATOR_WALLET_MISMATCH" });
  });
  it("refuses signed-out or disconnected sessions and a different connected wallet", () => {
    expect(bindLaunchCreator(body, { ...ctx, sessionWallet: null })).toEqual({ ok: false, code: "CREATOR_SESSION_REQUIRED" });
    expect(bindLaunchCreator(body, { ...ctx, connectedWallet: null })).toEqual({ ok: false, code: "WALLET_DISCONNECTED" });
    expect(bindLaunchCreator(body, { ...ctx, connectedWallet: k() })).toEqual({ ok: false, code: "CONNECTED_WALLET_MISMATCH" });
  });
  it("never lets the native deployer or an MCPX wallet be the creator", () => {
    expect(bindLaunchCreator(body, { ...ctx, sessionWallet: deployer, connectedWallet: deployer })).toEqual({ ok: false, code: "CREATOR_IS_NATIVE_DEPLOYER" });
    expect(bindLaunchCreator(body, { ...ctx, sessionWallet: ops, connectedWallet: ops })).toEqual({ ok: false, code: "CREATOR_IS_MCPX_RECIPIENT" });
    expect(bindLaunchCreator(body, { ...ctx, opsRecipient: null })).toEqual({ ok: false, code: "FEE_RECIPIENTS_NOT_CONFIGURED" });
  });
  it("accepts only a candidate with 60% session wallet / 25% ops / 15% platform", () => {
    expect(checkCandidateBinding(good, { ...ctx, mint })).toEqual({ ok: true });
  });
  it("refuses tampered candidates", () => {
    const x = { ...ctx, mint };
    expect(checkCandidateBinding({ ...good, shareholders: [{ address: deployer, bps: 6000 }, good.shareholders[1], good.shareholders[2]] }, x)).toMatchObject({ code: "SHARES_MISMATCH" });
    expect(checkCandidateBinding({ ...good, shareholders: [{ address: me, bps: 7000 }, good.shareholders[1], { address: plat, bps: 500 }] }, x)).toMatchObject({ code: "SHARES_MISMATCH" });
    expect(checkCandidateBinding({ ...good, feePayer: k() }, x)).toMatchObject({ code: "FEE_PAYER_NOT_CREATOR" });
    expect(checkCandidateBinding({ ...good, signers: [k(), mint] }, x)).toMatchObject({ code: "SIGNERS_MISMATCH" });
    expect(checkCandidateBinding({ ...good, mint: k() }, x)).toMatchObject({ code: "MINT_MISMATCH" });
  });
});
