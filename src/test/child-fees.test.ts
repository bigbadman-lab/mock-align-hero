import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { verifyChild, planChild, verifyChildSettlement, memoryChildStore, runChildFeePass, childIntentKey, TOKEN_2022, type ChildRecord, type OnchainChild, type KeeperDeps, type FinalTx } from "../../services/rewards-worker/src/child-fees";

const k = () => Keypair.generate().publicKey.toBase58();
const MCP = k();
const mk = (): ChildRecord => ({ mint: k(), creator: k(), ops: k(), platform: k(), quoteMint: MCP, quoteTokenProgram: TOKEN_2022, sharingConfig: k() });
const onchain = (c: ChildRecord, over: Partial<OnchainChild> = {}): OnchainChild => ({
  sharingConfig: { mint: c.mint, adminRevoked: true, shareholders: [{ address: c.creator, shareBps: 6000 }, { address: c.ops, shareBps: 2500 }, { address: c.platform, shareBps: 1500 }] },
  curveCreator: c.sharingConfig, curveQuoteMint: MCP, quoteMintOwner: TOKEN_2022, graduated: false, ...over,
});

describe("child fee split verification", () => {
  it("accepts exactly 6000/2500/1500 locked on chain", () => { const c = mk(); expect(verifyChild(c, onchain(c), MCP)).toEqual({ ok: true }); });
  it("rejects unlocked, tampered, reordered or missing configs", () => {
    const c = mk();
    expect(verifyChild(c, onchain(c, { sharingConfig: { ...onchain(c).sharingConfig!, adminRevoked: false } }), MCP)).toEqual({ ok: false, code: "SHARES_NOT_LOCKED" });
    const sh = onchain(c).sharingConfig!.shareholders;
    expect(verifyChild(c, onchain(c, { sharingConfig: { mint: c.mint, adminRevoked: true, shareholders: [{ ...sh[0], shareBps: 6001 }, sh[1], { ...sh[2], shareBps: 1499 }] } }), MCP)).toMatchObject({ code: "SHARES_MISMATCH" });
    expect(verifyChild(c, onchain(c, { sharingConfig: { mint: c.mint, adminRevoked: true, shareholders: [sh[1], sh[0], sh[2]] } }), MCP)).toMatchObject({ code: "SHARES_MISMATCH" });
    expect(verifyChild(c, onchain(c, { sharingConfig: { mint: c.mint, adminRevoked: true, shareholders: [{ address: k(), shareBps: 6000 }, sh[1], sh[2]] } }), MCP)).toMatchObject({ code: "SHARES_MISMATCH" });
    expect(verifyChild(c, onchain(c, { sharingConfig: null }), MCP)).toMatchObject({ code: "SHARING_CONFIG_MISSING" });
    expect(verifyChild(c, onchain(c, { curveCreator: c.creator }), MCP)).toMatchObject({ code: "CURVE_CREATOR_NOT_SHARING_CONFIG" });
  });
  it("requires the canonical $MCP mint and Token-2022", () => {
    const c = mk();
    expect(verifyChild(c, onchain(c), null)).toMatchObject({ code: "QUOTE_MINT_UNSET" });
    expect(verifyChild(c, onchain(c), k())).toMatchObject({ code: "QUOTE_MINT_MISMATCH" });
    expect(verifyChild(c, onchain(c, { quoteMintOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }), MCP)).toMatchObject({ code: "QUOTE_TOKEN_PROGRAM_MISMATCH" });
  });
});

describe("thresholds and gas budget", () => {
  const base = { graduated: false, curveVaultQuote: 1000n, ammVaultQuote: 0n, minDistributable: 500n, estCostLamports: 10_000n, gasRemainingLamports: 100_000n };
  it("distributes above minimum, sweeps first after graduation", () => {
    expect(planChild(base)).toEqual({ action: "DISTRIBUTE", amount: 1000n });
    expect(planChild({ ...base, graduated: true, ammVaultQuote: 50n })).toEqual({ action: "SWEEP_THEN_DISTRIBUTE", amount: 1050n });
  });
  it("skips zero, below-minimum, unknown balances and exhausted/unset gas", () => {
    expect(planChild({ ...base, curveVaultQuote: 0n })).toMatchObject({ code: "NOTHING_ACCRUED" });
    expect(planChild({ ...base, curveVaultQuote: 499n })).toMatchObject({ code: "BELOW_MINIMUM" });
    expect(planChild({ ...base, curveVaultQuote: null })).toMatchObject({ code: "BALANCE_UNKNOWN" });
    expect(planChild({ ...base, graduated: true, ammVaultQuote: null })).toMatchObject({ code: "BALANCE_UNKNOWN" });
    expect(planChild({ ...base, gasRemainingLamports: 9_999n })).toMatchObject({ code: "GAS_BUDGET_EXHAUSTED" });
    expect(planChild({ ...base, gasRemainingLamports: null })).toMatchObject({ code: "GAS_BUDGET_NOT_CONFIGURED" });
  });
});

describe("finalized settlement proof", () => {
  const c = mk(), vault = k(), keeper = k();
  const tx = (d: Record<string, bigint>, over: Partial<FinalTx> = {}): FinalTx => ({
    finalized: true, err: null, slot: 1, feePayer: keeper,
    pre: Object.keys(d).map((o) => ({ owner: o, mint: MCP, amount: 1_000_000n })),
    post: Object.entries(d).map(([o, v]) => ({ owner: o, mint: MCP, amount: 1_000_000n + v })), ...over,
  });
  it("proves an exact 60/25/15 payout with rounding", () => {
    const r = verifyChildSettlement(tx({ [vault]: -1001n, [c.creator]: 601n, [c.ops]: 250n, [c.platform]: 150n }), c, vault, keeper);
    expect(r).toMatchObject({ state: "PROVEN", distributed: 1001n });
  });
  it("refuses wrong shares, keeper receipts, unfinalized or missing txs", () => {
    expect(verifyChildSettlement(tx({ [vault]: -1000n, [c.creator]: 700n, [c.ops]: 150n, [c.platform]: 150n }), c, vault, keeper)).toMatchObject({ state: "MISMATCH" });
    expect(verifyChildSettlement(tx({ [vault]: -1000n, [c.creator]: 600n, [c.ops]: 250n, [c.platform]: 140n, [keeper]: 10n }), c, vault, keeper)).toMatchObject({ code: "KEEPER_RECEIVED_FUNDS" });
    expect(verifyChildSettlement(tx({}, { finalized: false }), c, vault, keeper)).toMatchObject({ state: "UNKNOWN" });
    expect(verifyChildSettlement(null, c, vault, keeper)).toMatchObject({ state: "UNKNOWN" });
  });
});

describe("keeper durability", () => {
  const deps = (store = memoryChildStore(), c = mk(), over: Partial<KeeperDeps> = {}): KeeperDeps => ({
    now: () => 1_800_000_000, canonicalQuote: MCP, keeper: k(), dailyGasLamports: 1_000_000n, minDistributable: 1n,
    children: async () => [c], readChild: async () => onchain(c), balances: async () => ({ curveVaultQuote: 5000n, ammVaultQuote: 0n }),
    estimateCost: async () => 20_000n, buildAndSign: async () => ({ signature: "sig-" + c.mint, signedBase64: "AA==", lastValidBlockHeight: 100 }),
    send: null, fetchFinal: async () => null, finalizedBlockHeight: async () => 50, vaultOwner: () => k(), childByMint: (m) => (m === c.mint ? c : undefined), store, ...over,
  });
  it("20 parallel workers reserve exactly one intent per child window", async () => {
    const store = memoryChildStore(), c = mk();
    const keys = await Promise.all(Array.from({ length: 20 }, () => store.reserve({ key: childIntentKey(c.mint, 1_800_000_000), mint: c.mint, costLamports: 1n })));
    expect(keys.filter((x) => x === "RESERVED").length).toBe(1);
  });
  it("signs and holds (no broadcast), then after restart neither re-signs nor marks paid without proof", async () => {
    const store = memoryChildStore(), c = mk();
    expect(await runChildFeePass(deps(store, c))).toContainEqual({ mint: c.mint, result: "SIGNED_HELD:DISTRIBUTE" });
    const again = await runChildFeePass(deps(store, c));
    expect(again).toContainEqual({ mint: c.mint, result: "SIGNED_HELD" });
    expect(again).toContainEqual({ mint: c.mint, result: "SKIP:OPEN_INTENT" });
    expect([...store.rows.values()][0].status).toBe("SIGNED");
  });
  it("expires only past the finalized block height", async () => {
    const store = memoryChildStore(), c = mk();
    await runChildFeePass(deps(store, c));
    await runChildFeePass(deps(store, c, { finalizedBlockHeight: async () => 101 }));
    expect([...store.rows.values()][0].status).toBe("EXPIRED");
  });
  it("holds everything without a gas budget or with an unverified split", async () => {
    const c = mk();
    expect(await runChildFeePass(deps(memoryChildStore(), c, { dailyGasLamports: null }))).toContainEqual({ mint: "*", result: "SKIP:GAS_BUDGET_NOT_CONFIGURED" });
    expect(await runChildFeePass(deps(memoryChildStore(), c, { readChild: async () => onchain(c, { sharingConfig: { ...onchain(c).sharingConfig!, adminRevoked: false } }) }))).toContainEqual({ mint: c.mint, result: "HELD:SHARES_NOT_LOCKED" });
    expect(await runChildFeePass(deps(memoryChildStore(), c, { readChild: async () => { throw new Error("rpc"); } }))).toContainEqual({ mint: c.mint, result: "HELD:RPC_UNAVAILABLE" });
  });
});
