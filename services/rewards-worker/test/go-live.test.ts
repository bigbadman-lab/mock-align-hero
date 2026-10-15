import { describe, it, expect } from "bun:test";
import { livePolicy, ensureLivePolicy, liveFlags, type LiveChecks } from "../src/go-live";
import { executionReadiness } from "../src/signer";
import { runWindow } from "../src/orchestrator";
import { policyLiveAllowed } from "../../../src/lib/rewards/eligibility-policy";

const MINT = "So11111111111111111111111111111111111111112";
const DEP = "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2";
const ok: LiveChecks = { mint: MINT, launchDerived: true, decimals: 6, policy: livePolicy({ mint: MINT, deployer: DEP, genesisWindow: 0, verifiedAt: "x" }),
  indexSynced: true, openGaps: 0, createdMints: [MINT], intentStoreOk: true, senderOn: true, deployerLamports: 20_000_000n, minReserveLamports: 10_000_000n, signerAddress: DEP, deployer: DEP };
const ready = (c: LiveChecks) => executionReadiness({ signer: "SIGNER_VALIDATED" as never, limitsSet: true, emergencyStop: false, ...liveFlags(c) });

describe("go-live", () => {
  it("standing policy is approved and excludes curve + pool", () => {
    expect(policyLiveAllowed(ok.policy!)).toBe(true);
    expect(ok.policy!.poolVaults).toHaveLength(2);
  });
  it("all real checks passing → EXECUTION_READY", () => expect(ready(ok).state).toBe("EXECUTION_READY"));
  it("each failing check blocks", () => {
    expect(ready({ ...ok, deployerLamports: 1n }).blockers).toContain("RESERVES_UNVERIFIED");
    expect(ready({ ...ok, createdMints: [MINT, DEP] }).blockers).toContain("FEE_OWNERSHIP_UNCONFIRMED");
    expect(ready({ ...ok, signerAddress: MINT }).blockers).toContain("OPERATOR_NOT_AUTHORIZED");
    expect(ready({ ...ok, openGaps: 1 }).blockers).toContain("SNAPSHOT_INCOMPLETE");
    expect(ready({ ...ok, senderOn: false }).blockers).toContain("SIMULATIONS_NOT_PASSED");
  });
  it("ready worker reaches the snapshot stage (not held at readiness)", async () => {
    const r = await runWindow({ readiness: () => ready(ok), sealed: async () => null } as never, 0);
    expect(r[0]!.stage).toBe("SNAPSHOT");
  });
  it("never overwrites an existing policy for the mint", async () => {
    let saved = 0; const existing = { ...ok.policy!, version: "elig-v1-custom" };
    const p = await ensureLivePolicy({ load: async () => [existing], save: async () => { saved++; } }, { mint: MINT, deployer: DEP, genesisWindow: 0 });
    expect(saved).toBe(0); expect(p!.version).toBe("elig-v1-custom");
  });
  it("publishes once when none exists", async () => {
    let saved = 0;
    await ensureLivePolicy({ load: async () => [], save: async () => { saved++; } }, { mint: MINT, deployer: DEP, genesisWindow: 0 });
    expect(saved).toBe(1);
  });
});
