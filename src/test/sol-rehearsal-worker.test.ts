// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { runRehearsalVerifier, verifyRehearsalLaunch, rehearsalClaimOf, NATIVE_SOL, PUMP_PROGRAM, type Claim, type LaunchTx, type RehearsalDeps, type RehearsalPermission } from "../../services/rewards-worker/src/launch-verify";
import type { OnchainChild } from "../../services/rewards-worker/src/child-fees";

const k = () => Keypair.generate().publicKey.toBase58();
const creator = k(), mint = k(), ops = k(), plat = k(), dep = k(), sc = k();
const sig = "5".repeat(88);
const a = { ops, platform: plat, nativeDeployer: dep };
const claim: Claim = { id: "c1", draftId: "d1", draftRevision: 1, creator, mint, signature: sig };
const perm: RehearsalPermission = { creator, status: "SUBMITTED", mint, signature: sig };
const tx = (over: Partial<Extract<LaunchTx, { found: true }>> = {}): LaunchTx => ({ found: true, finalized: true, err: null, slot: 42, accountKeys: [creator, mint, PUMP_PROGRAM], numSigners: 2, programIds: [PUMP_PROGRAM], ...over });
const chain = (over: Partial<OnchainChild> = {}): OnchainChild => ({
  sharingConfig: { mint, adminRevoked: true, shareholders: [{ address: creator, shareBps: 6000 }, { address: ops, shareBps: 2500 }, { address: plat, shareBps: 1500 }] },
  curveCreator: sc, curveQuoteMint: NATIVE_SOL, quoteMintOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", graduated: false, ...over } as OnchainChild);

function deps(over: Partial<RehearsalDeps> = {}, log: string[] = []): RehearsalDeps {
  return {
    permission: async () => perm, pending: async () => [claim], readTx: async () => tx(), readChild: async () => chain(), sharingConfigOf: () => sc,
    reject: async (id, code) => { log.push(`reject:${id}:${code}`); return "rejected"; },
    registerRehearsal: async (id, slot) => { log.push(`register:${id}:${slot}`); return "registered:p1"; }, ...over,
  };
}

describe("SOL rehearsal confirmation (Worker #3)", () => {
  it("verified SOL creation registers through the atomic SQL step", async () => {
    const log: string[] = [];
    expect(await runRehearsalVerifier(deps({}, log), a)).toEqual([{ claim: "c1", result: "registered:p1" }]);
    expect(log).toEqual(["register:c1:42"]);
  });
  it("only the claim matching the submitted permission is the rehearsal; unrelated SOL tokens never are", () => {
    expect(rehearsalClaimOf(perm, [{ ...claim, mint: k() }])).toBeNull();
    expect(rehearsalClaimOf(perm, [{ ...claim, creator: k() }])).toBeNull();
    expect(rehearsalClaimOf({ ...perm, status: "RESERVED" }, [claim])).toBeNull();
    expect(rehearsalClaimOf(perm, [claim])).toBe(claim);
  });
  it("delayed processing / not yet finalized holds without rejecting", async () => {
    expect((await runRehearsalVerifier(deps({ readTx: async () => ({ found: false }) }), a))[0]!.result).toBe("HELD:TX_NOT_FOUND");
    expect((await runRehearsalVerifier(deps({ readTx: async () => tx({ finalized: false }) }), a))[0]!.result).toBe("HELD:TX_NOT_FINALIZED");
  });
  it("database or RPC unavailable holds", async () => {
    expect((await runRehearsalVerifier(deps({ permission: async () => { throw new Error("db"); } }), a))[0]!.result).toBe("HELD:REHEARSAL_UNAVAILABLE");
    expect((await runRehearsalVerifier(deps({ readTx: async () => { throw new Error("rpc"); } }), a))[0]!.result).toBe("HELD:EVIDENCE_UNAVAILABLE");
  });
  it("wrong quote, fee recipients, creator or unlocked shares are rejected (permission stays used-up)", async () => {
    const cases: [Partial<OnchainChild>, string][] = [
      [{ curveQuoteMint: k() }, "QUOTE_NOT_NATIVE_SOL"],
      [{ sharingConfig: { mint, adminRevoked: true, shareholders: [{ address: creator, shareBps: 6000 }, { address: k(), shareBps: 2500 }, { address: plat, shareBps: 1500 }] } } as any, "OPS_RECIPIENT_MISMATCH"],
      [{ sharingConfig: { mint, adminRevoked: false, shareholders: [] } } as any, "SHARES_NOT_LOCKED"],
    ];
    for (const [o, code] of cases) {
      const log: string[] = [];
      expect((await runRehearsalVerifier(deps({ readChild: async () => chain(o) }, log), a))[0]!.result).toBe(`REJECTED:${code}`);
      expect(log.some((x) => x.startsWith("register"))).toBe(false);
    }
    expect(verifyRehearsalLaunch(claim, perm, tx({ accountKeys: [k(), mint] }), chain(), a, sc)).toMatchObject({ ok: false, code: "FEE_PAYER_NOT_CREATOR" });
    expect(verifyRehearsalLaunch({ ...claim, mint: k() }, perm, tx(), chain(), a, sc)).toMatchObject({ ok: false, code: "NOT_THE_REHEARSAL" });
  });
  it("registration failure after confirmation holds for retry; duplicate runs are idempotent at the SQL step", async () => {
    expect((await runRehearsalVerifier(deps({ registerRehearsal: async () => { throw new Error("rehearsal_consume_failed:mismatch"); } }), a))[0]!.result).toMatch(/^HELD:REGISTER_FAILED/);
    expect((await runRehearsalVerifier(deps({ registerRehearsal: async () => "already_verified:p1" }), a))[0]!.result).toBe("already_verified:p1");
  });
  it("worker restart: a consumed permission yields no further work", async () => {
    expect(await runRehearsalVerifier(deps({ permission: async () => ({ ...perm, status: "CONSUMED" }) }), a)).toEqual([]);
  });
});
