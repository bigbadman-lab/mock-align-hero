import { describe, expect, it } from "vitest";
import { decodeSharing, checkNativeSplit, splitRewardsReceipt, sharingConfigPda } from "@/lib/rewards/pump-sharing";
import { decodeFeeEvents } from "@/lib/rewards/pump-events";
import amm from "./fixtures/pump-sharing/sh_GsBaY54o.json";
import big from "./fixtures/pump-sharing/sh_4S2UVibM.json";
import multiZero from "./fixtures/pump-sharing/multi_39ziCWUq.json";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("real fee-sharing distributions (mainnet, finalized)", () => {
  it("decodes 685,840,141 lamports for mint 5JRg…pump, bound to its derived sharing config", async () => {
    const d = await decodeSharing(big as never);
    if (d.kind !== "OK") throw new Error(d.kind);
    const x = d.distributions[0]!;
    expect(x).toMatchObject({ slot: 456188227, mint: "5JRgtF4Fwnv3eNmNPuAur6dEzh83ix6mtYP4XALupump", sharingConfig: "DXoBhcKQ1vCkLgpURgvipZBdEawGTZLqcoqZspY7uCS3", distributed: 685840141n, asset: "SOL" });
    expect(await sharingConfigPda(x.mint)).toBe(x.sharingConfig);
    expect(x.receipts.reduce((s, r) => s + r.lamports, 0n)).toBe(x.distributed);
  });
  it("AMM→Pump sweep is a vault movement, recorded separately and never as a receipt", async () => {
    const d = await decodeSharing(amm as never);
    if (d.kind !== "OK") throw new Error();
    expect(d.sweeps).toHaveLength(1);
    expect(d.sweeps[0]!.to).toBe(d.distributions[0]!.creatorVault);
    expect(d.sweeps[0]!.lamports).toBe(d.distributions[0]!.distributed); // swept then distributed: count once
    expect(d.distributions).toHaveLength(1);
  });
  it("two-shareholder config with nothing accrued: legitimate zero, both shares read (2500/7500)", async () => {
    const d = await decodeSharing(multiZero as never);
    if (d.kind !== "OK") throw new Error();
    expect(d.distributions[0]!.receipts.map((r) => [r.shareBps, r.lamports])).toEqual([[2500, 0n], [7500, 0n]]);
  });
  it("sharing-config coins are invisible to the single-recipient decoder (no double source)", () => {
    expect(decodeFeeEvents(big as never).kind).toBe("SKIP");
  });
  it("refuses: failed tx, forged event authority, tampered amount, wrong mint binding, non-shareholder transfer", async () => {
    const f = clone(big) as any; f.meta.err = { x: 1 };
    expect((await decodeSharing(f)).kind).toBe("SKIP");
    const forged = clone(big) as any;
    for (const g of forged.meta.innerInstructions) for (const ix of g.instructions) if (ix.accounts.length === 1) ix.accounts = [0];
    expect(await decodeSharing(forged)).toEqual({ kind: "UNKNOWN", reason: "event_authority_mismatch" });
    const tamper = clone(big) as any; const bs58 = (await import("bs58")).default;
    for (const g of tamper.meta.innerInstructions) for (const ix of g.instructions) { const d = bs58.decode(ix.data); if (d.length === 12 && d[0] === 2) { d[4] = d[4]! ^ 1; ix.data = bs58.encode(d); } }
    expect(await decodeSharing(tamper)).toEqual({ kind: "UNKNOWN", reason: "transfers_do_not_match_distributed" });
    const wrongMint = clone(big) as any;
    for (const g of wrongMint.meta.innerInstructions) for (const ix of g.instructions) { const d = bs58.decode(ix.data); if (d.length > 150 && d[0] === 0xe4) { d[30] = d[30]! ^ 1; ix.data = bs58.encode(d); } }
    expect(await decodeSharing(wrongMint)).toEqual({ kind: "UNKNOWN", reason: "sharing_config_not_derived_from_mint" });
    expect((await decodeSharing(null)).kind).toBe("UNKNOWN");
  });
  it("a real non-$MCP distribution fails the native 6000/4000 policy and can never be credited", async () => {
    const d = await decodeSharing(big as never); if (d.kind !== "OK") throw new Error();
    const c = checkNativeSplit(d.distributions[0]!, { mint: "MCPMINT", rewardsTreasury: "R", operationsTreasury: "O" });
    expect(c.ok).toBe(false);
    expect(c.issues).toEqual(["wrong_mint", "shareholder_count_not_2", "rewards_share_not_6000", "operations_share_not_4000"]);
  });
});

describe("native 60/40 policy and internal 50/50", () => {
  const dist = (r: bigint, o: bigint, rb = 6000, ob = 4000) => ({ signature: "s", slot: 1, blockTime: 1, ixIndex: 0, eventIndex: 0, mint: "M", bondingCurve: "b", sharingConfig: "c", creatorVault: "v", admin: "a", quoteMint: "q", distributed: r + o, asset: "SOL" as const,
    receipts: [{ address: "R", shareBps: rb, lamports: r }, { address: "O", shareBps: ob, lamports: o }] });
  it("accepts exactly 6000/4000 to the approved treasuries", () => {
    expect(checkNativeSplit(dist(600n, 400n), { mint: "M", rewardsTreasury: "R", operationsTreasury: "O" })).toMatchObject({ ok: true, rewards: 600n, operations: 400n });
    expect(checkNativeSplit(dist(500n, 500n, 5000, 5000), { mint: "M", rewardsTreasury: "R", operationsTreasury: "O" }).ok).toBe(false);
  });
  it("50/50 of ACTUAL rewards lamports never invents a lamport; odd lamport goes to buyback", () => {
    for (const n of [0n, 1n, 2n, 3n, 685840141n, 18446744073709551615n]) { const s = splitRewardsReceipt(n); expect(s.solPayout + s.buyback).toBe(n); expect(s.buyback - s.solPayout).toBe(n % 2n); }
  });
});
