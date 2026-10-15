// @vitest-environment node
import { describe, it, expect } from "vitest";
import fx from "./fixtures/settlement/mainnet.json";
import { verifySettlement, verifyFill, type FinalTx, type Expected } from "../../services/rewards-worker/src/settlement";
import { runWindow, runPassWindows, type OrchestratorDeps, type SubmitOutcome } from "../../services/rewards-worker/src/orchestrator";

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const keys = (t: any): string[] => [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];

// Expected rows are derived independently from the real finalized fixture, then the verifier must agree.
const solTx = (fx as any).sol as FinalTx & any;
const solExpected = (): Expected => {
  const k = keys(solTx); const rows = [];
  for (let i = 1; i < k.length; i++) { const d = BigInt(solTx.meta.postBalances[i]) - BigInt(solTx.meta.preBalances[i]); if (d > 0n) rows.push({ owner: k[i]!, amount: d }); }
  return { kind: "SOL_PAYOUT", signature: solTx.transaction.signatures[0], deployer: k[0]!, messageSha256: "x", rows };
};
const tokTx = (fx as any).token.t as any;
const tokExpected = (): Expected => {
  const payer = keys(tokTx)[0]!; const m = new Map<string, bigint>(); let mint = "";
  for (const b of tokTx.meta.postTokenBalances) { mint = b.mint; m.set(b.owner, (m.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount)); }
  for (const b of tokTx.meta.preTokenBalances) m.set(b.owner, (m.get(b.owner) ?? 0n) - BigInt(b.uiTokenAmount.amount));
  const sender = [...m].find(([, d]) => d < 0n)![0];
  return { kind: "TOKEN_PAYOUT", signature: tokTx.transaction.signatures[0], deployer: sender === payer ? payer : sender, messageSha256: "x", mint, tokenProgram: T22,
    rows: [...m].filter(([, d]) => d > 0n).map(([owner, amount]) => ({ owner, amount })) };
};

describe("C01 settlement proof on REAL finalized mainnet transactions", () => {
  it("SOL transfer: exact recipient deltas + fee reconcile", () => {
    const p = verifySettlement(solTx, solExpected());
    expect(p.kind).toBe("PROVEN");
    if (p.kind === "PROVEN") expect(BigInt(p.deployerDebit)).toBe(solExpected().rows.reduce((a, r) => a + r.amount, 0n) + BigInt(p.feeLamports));
  });
  it("Token-2022 transfer: per-owner token deltas, ATA rent separated", () => {
    const e = tokExpected();
    const p = verifySettlement(tokTx, e);
    if (e.deployer !== keys(tokTx)[0]) expect(p).toEqual({ kind: "MISMATCH", reason: "FEE_PAYER_NOT_DEPLOYER" });
    else { expect(p.kind).toBe("PROVEN"); if (p.kind === "PROVEN") expect(p.delivered.length).toBe(e.rows.length); }
  });
  it("missing / not-finalized evidence is UNKNOWN, never zero or failed", () => {
    expect(verifySettlement(null, solExpected()).kind).toBe("UNKNOWN");
    expect(verifySettlement({ ...clone(solTx), meta: null }, solExpected()).kind).toBe("UNKNOWN");
    const bad = clone(solTx); bad.meta.postBalances = bad.meta.postBalances.slice(1);
    expect(verifySettlement(bad, solExpected()).kind).toBe("UNKNOWN");
  });
  it("rejects wrong signature, tx error, wrong amount, incomplete batch, extra movement, wrong payer", () => {
    expect(verifySettlement(solTx, { ...solExpected(), signature: "other" })).toEqual({ kind: "MISMATCH", reason: "SIGNATURE_MISMATCH" });
    const err = clone(solTx); err.meta.err = { InstructionError: [0, "x"] };
    expect(verifySettlement(err, solExpected())).toEqual({ kind: "MISMATCH", reason: "TX_FAILED_ON_CHAIN" });
    const e = solExpected();
    expect(verifySettlement(solTx, { ...e, rows: e.rows.map((r) => ({ ...r, amount: r.amount + 1n })) }).kind).toBe("MISMATCH");
    expect(verifySettlement(solTx, { ...e, rows: [...e.rows, { owner: "11111111111111111111111111111112", amount: 5n }] })).toEqual({ kind: "MISMATCH", reason: "INCOMPLETE_BATCH" });
    if (e.rows.length > 1) expect(verifySettlement(solTx, { ...e, rows: e.rows.slice(1) }).kind).toBe("MISMATCH");
    expect(verifySettlement(solTx, { ...e, deployer: "X" })).toEqual({ kind: "MISMATCH", reason: "FEE_PAYER_NOT_DEPLOYER" });
  });
  it("wrong mint or wrong token program is refused", () => {
    const e = tokExpected(); if (e.deployer !== keys(tokTx)[0]) return;
    expect(verifySettlement(tokTx, { ...e, mint: "OTHER" })).toEqual({ kind: "MISMATCH", reason: "WRONG_MINT_MOVED" });
    expect(verifySettlement(tokTx, { ...e, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" })).toEqual({ kind: "MISMATCH", reason: "WRONG_TOKEN_PROGRAM" });
  });
  it("persisted message hash must match the stored bytes", () => {
    expect(verifySettlement(solTx, { ...solExpected(), messageBase64: "AAAA", messageSha256: "0".repeat(64) })).toEqual({ kind: "MISMATCH", reason: "PERSISTED_MESSAGE_HASH_MISMATCH" });
  });
});

describe("C02 buyback fill proof", () => {
  const D = "Dep1oyer", M = "MCPmint";
  const tx = (preTok: string | null, postTok: string, solPre = 10_000_000, solPost = 8_990_000, err: unknown = null): FinalTx => ({
    slot: 9, transaction: { signatures: ["fillsig"], message: { accountKeys: [D, "ata", "pool"] } },
    meta: { err, fee: 10_000, preBalances: [solPre, preTok === null ? 0 : 2_039_280, 5], postBalances: [solPost, 2_039_280, 5],
      preTokenBalances: preTok === null ? [] : [{ accountIndex: 1, mint: M, owner: D, uiTokenAmount: { amount: preTok } }],
      postTokenBalances: [{ accountIndex: 1, mint: M, owner: D, uiTokenAmount: { amount: postTok } }] } });
  const e = { signature: "fillsig", deployer: D, mint: M, maxSolLamports: 1_000_000n, minOutTokens: 1n, venues: ["PUMP"] };
  it("credits only the net delta; pre-existing tokens are never counted", () => {
    const f = verifyFill(tx("500", "1500"), e, ["PUMP"]);
    expect(f).toMatchObject({ kind: "FILL", tokensReceived: "1000", solSpent: "1000000", rentLamports: "0" });
  });
  it("first buy: new ATA rent is not counted as swap spend", () => {
    const f = verifyFill(tx(null, "1000", 10_000_000, 6_950_720), e, ["PUMP"]);
    expect(f).toMatchObject({ kind: "FILL", rentLamports: "2039280", solSpent: "1000000" });
  });
  it("failed / no-output / over-budget / wrong venue / below min-out / unknown never create inventory", () => {
    expect(verifyFill(tx("0", "0"), e, ["PUMP"]).kind).toBe("MISMATCH");
    expect(verifyFill(tx("0", "10", 10_000_000, 8_990_000, { e: 1 }), e, ["PUMP"])).toEqual({ kind: "MISMATCH", reason: "SWAP_FAILED_ON_CHAIN" });
    expect(verifyFill(tx("0", "10", 10_000_000, 7_000_000), e, ["PUMP"])).toEqual({ kind: "MISMATCH", reason: "SOL_SPENT_ABOVE_BUDGET" });
    expect(verifyFill(tx("0", "10"), e, ["JUPITER"])).toEqual({ kind: "MISMATCH", reason: "SWAP_PROGRAM_NOT_ALLOWED" });
    expect(verifyFill(tx("0", "10"), { ...e, minOutTokens: 11n }, ["PUMP"])).toEqual({ kind: "MISMATCH", reason: "BELOW_MIN_OUT" });
    expect(verifyFill(null, e, ["PUMP"]).kind).toBe("UNKNOWN");
  });
});

describe("C03 five-minute orchestration", () => {
  const W = 1_800_000_000 - (1_800_000_000 % 300);
  const mk = (o: Partial<OrchestratorDeps> & { seen?: Set<string> } = {}) => {
    const seen = o.seen ?? new Set<string>(); const calls: string[] = [];
    const d: OrchestratorDeps = {
      readiness: () => ({ state: "EXECUTION_READY", blockers: [] }),
      sealed: async () => ({ snapshotComplete: true, solRows: Array.from({ length: 45 }, (_, i) => ({ owner: `h${String(i).padStart(2, "0")}`, amount: 10n })), tokenRowsFor: (inv) => (inv > 0n ? [{ owner: "h00", amount: inv }] : []) }),
      openForCycle: async () => 0, vaultLamports: async () => 0n,
      budget: async () => ({ sol: 450n, buyback: 0n, tokens: 0n, ops: 1_000_000n, evidence: true }),
      submit: async (_k, key): Promise<SubmitOutcome> => { calls.push(key); if (seen.has(key)) return "DUPLICATE"; seen.add(key); return "NEW_SIGNED"; },
      pendingFills: async () => 0, maxRecipientsPerTx: 20, ...o,
    };
    return { d, calls, seen };
  };
  it("not READY: every money stage is held (no fake-ready path)", async () => {
    const { d, calls } = mk({ readiness: () => ({ state: "BLOCKED", blockers: ["EXECUTION_NOT_APPROVED"] }) });
    expect((await runWindow(d, W))[0]).toMatchObject({ stage: "READINESS", status: "HELD" });
    expect(calls).toHaveLength(0);
  });
  it("empty window (no finalized fees) waits; unsealed waits; incomplete snapshot holds", async () => {
    expect((await runWindow(mk({ budget: async () => ({ sol: 0n, buyback: 0n, tokens: 0n, ops: 0n, evidence: false }) }).d, W)).at(-1)).toMatchObject({ reason: "NO_FINALIZED_FEES_FOR_WINDOW" });
    expect((await runWindow(mk({ sealed: async () => null }).d, W)).at(-1)).toMatchObject({ reason: "WINDOW_NOT_SEALED" });
    expect((await runWindow(mk({ sealed: async () => ({ snapshotComplete: false, solRows: [], tokenRowsFor: () => [] }) }).d, W)).at(-1)).toMatchObject({ status: "HELD" });
  });
  it("multi-batch SOL payout (45 holders → 3 batches), crash + rerun never creates a new payment", async () => {
    const a = mk(); const r1 = await runWindow(a.d, W);
    expect(r1.at(-1)).toMatchObject({ stage: "PAY_SOL", reason: "AWAITING_FINALIZED_PAYOUTS", detail: { batches: 3, signed: 3 } });
    const b = mk({ seen: a.seen }); const r2 = await runWindow(b.d, W); // restart: same deterministic keys → DUPLICATE
    expect(r2.find((x) => x.stage === "PAY_SOL")).toMatchObject({ status: "DONE" });
    expect(b.calls.filter((k) => k.startsWith("SOL_PAYOUT"))).toEqual(a.calls.filter((k) => k.startsWith("SOL_PAYOUT")));
  });
  it("uncertain transactions block new payments for the window", async () => {
    expect((await runWindow(mk({ openForCycle: async () => 2 }).d, W)).at(-1)).toMatchObject({ stage: "SETTLE_OPEN", status: "WAITING" });
  });
  it("buyback → wait for finality → wait for fill → token payout only from credited inventory", async () => {
    const seen = new Set<string>();
    const r1 = await runWindow(mk({ seen, budget: async () => ({ sol: 0n, buyback: 300n, tokens: 0n, ops: 1n, evidence: true }) }).d, W);
    expect(r1.at(-1)).toMatchObject({ stage: "BUY", reason: "AWAITING_FINALIZED_BUY" });
    const r2 = await runWindow(mk({ seen, budget: async () => ({ sol: 0n, buyback: 300n, tokens: 0n, ops: 1n, evidence: true }), pendingFills: async () => 1 }).d, W);
    expect(r2.at(-1)).toMatchObject({ stage: "FILL", status: "WAITING" });
    const x = mk({ seen, budget: async () => ({ sol: 0n, buyback: 300n, tokens: 777n, ops: 1n, evidence: true }), sealed: async () => ({ snapshotComplete: true, solRows: [], tokenRowsFor: (inv) => (inv > 0n ? [{ owner: "h00", amount: inv }] : []) }) });
    await runWindow(x.d, W);
    expect(x.calls.some((k) => k.startsWith("TOKEN_PAYOUT"))).toBe(true);
  });
  it("RPC outage waits; refused stage holds with reason", async () => {
    expect((await runWindow(mk({ vaultLamports: async () => null }).d, W)).at(-1)).toMatchObject({ reason: "RPC_UNAVAILABLE" });
    expect((await runWindow(mk({ vaultLamports: async () => 5n, submit: async () => "REFUSED" }).d, W)).at(-1)).toMatchObject({ stage: "COLLECT", status: "HELD" });
  });
  it("catch-up is ordered and bounded; stops at the first unfinished window", async () => {
    const res = await runPassWindows(mk().d, [W + 600, W, W + 300], 2);
    expect(res.map((r) => r.window)).toEqual([W]); // W waits on payouts → stop, no runaway
    const res2 = await runPassWindows(mk({ sealed: async () => ({ snapshotComplete: true, solRows: [], tokenRowsFor: () => [] }) }).d, [W + 600, W, W + 300], 2);
    expect(res2.map((r) => r.window)).toEqual([W, W + 300]);
  });
});
