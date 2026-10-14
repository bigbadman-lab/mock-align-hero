import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { SESSION_TTL_MS } from "@/lib/creator-auth/core";
import { gatePrepare, gateVerify, type GateDeps, type BuilderCall } from "@/lib/tx-builder/launch-gate";

const k = () => Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;
const me = k(), ops = k(), plat = k(), deployer = k(), mint = k();
const fresh = (wallet = me, ageMs = 60_000) => ({ wallet, expiresAt: new Date(NOW - ageMs + SESSION_TTL_MS).toISOString() });
const input = { idempotencyKey: "launch-0001", mint, name: "Child", symbol: "CHD", uri: "https://mcpx.fun/m.json", initialBuy: null, format: "v0_alt" as const, connectedWallet: me };
const binding = (creator = me) => ({ creator, mint, shareholders: [{ address: creator, bps: 6000 }, { address: ops, bps: 2500 }, { address: plat, bps: 1500 }] });
const okChecks = { payerIsCreator: true, signersExactlyCreatorAndMint: true, feeSharesExact: true };

function deps(over: Partial<GateDeps> = {}, calls: any[] = []): GateDeps {
  const builder: BuilderCall = async (op, body: any) => {
    calls.push([op, body]);
    if (op === "prepare") return { status: 200, body: { status: "UNSIGNED_CANDIDATE", messageBase64: "AA==", binding: binding(body.creator), bindingMac: "m" } };
    return { status: 200, body: { valid: body.bindingMac === "m" && body.messageBase64 === "AA==", code: "X", checks: okChecks } };
  };
  return { config: { enabled: true, opsRecipient: ops, platformRecipient: plat, nativeDeployer: deployer }, builder, now: () => NOW, ...over };
}

describe("launch path creator binding", () => {
  it("prepares with the session wallet as 60% creator, ignoring nothing silently", async () => {
    const calls: any[] = [];
    const r = await gatePrepare(input, fresh(), deps({}, calls));
    expect(r.http).toBe(200);
    expect(calls[0][1].creator).toBe(me);
    expect(calls[0][1]).not.toHaveProperty("connectedWallet");
  });
  it("forged browser creator is refused and never reaches the builder", async () => {
    const calls: any[] = [];
    expect((await gatePrepare({ ...input, creator: k() }, fresh(), deps({}, calls))).body["code"]).toBe("CREATOR_WALLET_MISMATCH");
    expect(calls).toEqual([]);
  });
  it("refuses signed-out, stale sign-in, disconnected or different connected wallet", async () => {
    expect((await gatePrepare(input, null, deps())).body["code"]).toBe("CREATOR_SESSION_REQUIRED");
    expect((await gatePrepare(input, fresh(me, 11 * 60_000), deps())).body["code"]).toBe("LAUNCH_REAUTH_REQUIRED");
    expect((await gatePrepare({ ...input, connectedWallet: undefined }, fresh(), deps())).body["code"]).toBe("WALLET_DISCONNECTED");
    expect((await gatePrepare({ ...input, connectedWallet: k() }, fresh(), deps())).body["code"]).toBe("CONNECTED_WALLET_MISMATCH");
  });
  it("stays off unless enabled and refuses without a configured native deployer", async () => {
    expect((await gatePrepare(input, fresh(), deps({ config: { enabled: false, opsRecipient: ops, platformRecipient: plat, nativeDeployer: deployer } }))).body["code"]).toBe("CHILD_LAUNCH_NOT_ENABLED");
    expect((await gatePrepare(input, fresh(), deps({ config: { enabled: true, opsRecipient: ops, platformRecipient: plat, nativeDeployer: null } }))).body["code"]).toBe("NATIVE_DEPLOYER_NOT_CONFIGURED");
    expect((await gatePrepare({ ...input, connectedWallet: deployer }, fresh(deployer), deps())).body["code"]).toBe("CREATOR_IS_NATIVE_DEPLOYER");
  });
  it("rejects a builder response that binds someone else at 60%", async () => {
    const d = deps({ builder: async () => ({ status: 200, body: { status: "UNSIGNED_CANDIDATE", messageBase64: "AA==", binding: binding(k()), bindingMac: "m" } }) });
    expect((await gatePrepare(input, fresh(), d)).body["code"]).toBe("BUILDER_CREATOR_CHANGED_SINCE_PREPARE");
  });
  it("verify passes for the same wallet and untouched candidate", async () => {
    expect((await gateVerify({ messageBase64: "AA==", binding: binding(), bindingMac: "m", connectedWallet: me }, fresh(), deps())).http).toBe(200);
  });
  it("wallet changed between preparation and signing is refused", async () => {
    const other = k();
    expect((await gateVerify({ messageBase64: "AA==", binding: binding(), bindingMac: "m", connectedWallet: other }, fresh(other), deps())).body["code"]).toBe("CREATOR_CHANGED_SINCE_PREPARE");
    expect((await gateVerify({ messageBase64: "AA==", binding: binding(), bindingMac: "m", connectedWallet: other }, fresh(), deps())).body["code"]).toBe("CONNECTED_WALLET_MISMATCH");
  });
  it("modified unsigned transaction or binding is refused", async () => {
    expect((await gateVerify({ messageBase64: "AQ==", binding: binding(), bindingMac: "m", connectedWallet: me }, fresh(), deps())).http).toBe(403);
    const sh = binding(); sh.shareholders[1] = { address: k(), bps: 2500 };
    expect((await gateVerify({ messageBase64: "AA==", binding: sh, bindingMac: "m", connectedWallet: me }, fresh(), deps())).body["code"]).toBe("SHARES_MISMATCH");
    const d = deps({ builder: async () => ({ status: 200, body: { valid: true, checks: { ...okChecks, payerIsCreator: false } } }) });
    expect((await gateVerify({ messageBase64: "AA==", binding: binding(), bindingMac: "m", connectedWallet: me }, fresh(), d)).body["code"]).toBe("CANDIDATE_INCONSISTENT");
  });
});
