// @vitest-environment node
import { describe, it, expect } from "vitest";
import fx from "./fixtures/settlement/mainnet.json";
import { sealedFromFrozen, vaultLamports, creatorVaults, settlementChain, deployerProvenance, type Frozen } from "../../services/rewards-worker/src/pipeline";
import { runWindow, type OrchestratorDeps, type SubmitOutcome } from "../../services/rewards-worker/src/orchestrator";
import { reconcileOpen, memoryExecStore } from "../../services/rewards-worker/src/executor";
import { split303040 } from "../../src/lib/rewards/native-single";

const W = (o: string, a: bigint, c = "ELIGIBLE") => ({ owner: o, amount: a, class: c, reason: null });
const frozen = (owners: Frozen["owners"], completeness = "COMPLETE"): Frozen => ({ completeness, cutoffSlot: 1, digest: "d", owners });

describe("D02 frozen snapshot → entitlements", () => {
  it("pro-rata, exact total, from the frozen snapshot only", () => {
    const s = sealedFromFrozen(frozen([W("A", 3n), W("B", 1n), W("DEP", 50n, "EXCLUDED")]), { deployer: "DEP", excluded: [], solTotal: 1001n, minPayable: 0n })!;
    expect(s.snapshotComplete).toBe(true);
    expect(s.solRows.reduce((a, r) => a + r.amount, 0n)).toBe(1001n);
    expect(s.solRows.find((r) => r.owner === "A")!.amount).toBe(751n);
    expect(s.tokenRowsFor(400n)).toEqual([{ owner: "A", amount: 300n }, { owner: "B", amount: 100n }]);
  });
  it("ambiguous owner, incomplete snapshot, or excluded address marked eligible → blocked", () => {
    const x = { deployer: "DEP", excluded: ["VAULT"], solTotal: 100n, minPayable: 0n };
    expect(sealedFromFrozen(frozen([W("A", 1n), W("P", 1n, "AMBIGUOUS")]), x)!.snapshotComplete).toBe(false);
    expect(sealedFromFrozen(frozen([W("A", 1n)], "PARTIAL"), x)!.snapshotComplete).toBe(false);
    expect(sealedFromFrozen(frozen([W("A", 1n), W("VAULT", 1n)]), x)!.snapshotComplete).toBe(false);
    expect(sealedFromFrozen(frozen([W("A", 1n), W("1nc1nerator11111111111111111111111111111111", 1n)]), x)!.solRows).toEqual([]);
    expect(sealedFromFrozen(null, x)).toBeNull();
  });
});

describe("D03 fee vaults + 30/30/40", () => {
  it("exact conservation for any amount", () => {
    for (const a of [1n, 3n, 10n, 9_999n, 123_456_789n, (1n << 63n) - 1n]) { const s = split303040(a); expect(s.solBudget + s.buybackBudget + s.operations).toBe(a); expect(s.solBudget).toBe(s.buybackBudget); }
  });
  it("vault = curve lamports above rent + PumpSwap WSOL; RPC failure is unknown, never zero", async () => {
    const v = await creatorVaults("8tFSzdA6uKq5PjcNfQUtjGehX5Eq6WtxJ4z6BTrHn9zU");
    expect(v.curveVault).not.toBe(v.ammWsolVault);
    const rpc = async (m: string) => m === "getAccountInfo" ? { value: { lamports: 5_890_880, data: ["", "base64"] } } : m === "getMinimumBalanceForRentExemption" ? 890_880 : { value: { amount: "2000" } };
    expect(await vaultLamports(rpc, "8tFSzdA6uKq5PjcNfQUtjGehX5Eq6WtxJ4z6BTrHn9zU")).toEqual({ curve: 5_000_000n, amm: 2000n, total: 5_002_000n });
    expect(await vaultLamports(async () => { throw new Error("down"); }, "8tFSzdA6uKq5PjcNfQUtjGehX5Eq6WtxJ4z6BTrHn9zU")).toBeNull();
  });
  it("provenance: other minted coins block, unknown history is null", async () => {
    const tx = (mints: string[]) => ({ transaction: { message: { accountKeys: [{ pubkey: "DEP", signer: true }], instructions: mints.map((m) => ({ parsed: { type: "initializeMint2", info: { mint: m } } })) } }, meta: { innerInstructions: [] } });
    const rpc = (txs: string[][]) => async (m: string, p: unknown[]) => m === "getSignaturesForAddress" ? txs.map((_, i) => ({ signature: `s${i}`, err: null })) : tx(txs[Number(String(p[0]).slice(1))]!);
    expect((await deployerProvenance(rpc([["MCP"]]), "DEP")).createdMints).toEqual(["MCP"]);
    expect((await deployerProvenance(rpc([["MCP"], ["OTHER"]]), "DEP")).createdMints).toEqual(["MCP", "OTHER"]);
    expect((await deployerProvenance(async () => { throw new Error("x"); }, "DEP")).createdMints).toBeNull();
  });
});

describe("D04 settlement from PERSISTED plan on real finalized mainnet tx", () => {
  const t = (fx as any).sol;
  const keys: string[] = t.transaction.message.accountKeys;
  const rows = keys.slice(1).map((k, i) => ({ owner: k, amount: BigInt(t.meta.postBalances[i + 1]) - BigInt(t.meta.preBalances[i + 1]) })).filter((r) => r.amount > 0n);
  const sig = t.transaction.signatures[0];
  const db = (plan: unknown) => ({ query: async () => ({ rows: plan ? [plan as Record<string, unknown>] : [] }) });
  const rpc = async (m: string) => m === "getSignatureStatuses" ? { value: [{ slot: t.slot, err: null, confirmationStatus: "finalized" }] } : m === "getBlockHeight" ? 1 : t;
  const open = (r = rows) => { const s = memoryExecStore(); s.seed({ idempotencyKey: "k-sol-1", kind: "SOL_PAYOUT", signature: "", signedBase64: "", lastValidBlockHeight: 9, rows: r }); return s; };
  const persisted = (r = rows) => ({ kind: "SOL_PAYOUT", message_sha256: "x", message_base64: null, plan_rows: r.map((x) => ({ owner: x.owner, amount: x.amount.toString() })), plan_mint: null, plan_token_program: null });
  it("matching persisted plan → LANDED with proof", async () => {
    const s = open(); await s.recordSigned("k-sol-1", sig, "QQ==");
    const p = { ...persisted(), message_base64: "QQ==", message_sha256: "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd" };
    expect((await reconcileOpen(s, settlementChain(rpc, db(p), keys[0]!), null))[0]!.action).toBe("LANDED");
  });
  it("mismatched persisted amounts or missing plan → HELD_NO_PROOF (never paid)", async () => {
    const bad = rows.map((r, i) => (i === 0 ? { ...r, amount: r.amount + 1n } : r));
    for (const p of [{ ...persisted(bad), message_base64: "QQ==", message_sha256: "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd" }, null]) {
      const s = open(); await s.recordSigned("k-sol-1", sig, "QQ==");
      expect((await reconcileOpen(s, settlementChain(rpc, db(p), keys[0]!), null))[0]!.action).toBe("HELD_NO_PROOF");
    }
  });
});

describe("D06 five-minute cycle end-to-end (memory deps)", () => {
  const deps = (o: Partial<OrchestratorDeps> = {}, submits: string[] = []): OrchestratorDeps => ({
    readiness: () => ({ state: "READY", blockers: [] }), maxRecipientsPerTx: 2,
    sealed: async () => sealedFromFrozen(frozen([W("A", 1n), W("B", 1n), W("C", 2n)]), { deployer: "D", excluded: [], solTotal: 300n, minPayable: 0n }),
    openForCycle: async () => 0, vaultLamports: async () => 0n, pendingFills: async () => 0,
    budget: async () => ({ sol: 300n, buyback: 0n, tokens: 40n, ops: 10_000n, evidence: true }),
    submit: async (kind, key): Promise<SubmitOutcome> => { const dup = submits.includes(key); submits.push(key); return dup ? "DUPLICATE" : "NEW_SIGNED"; void kind; }, ...o });
  it("not READY holds before any money stage", async () => {
    const r = await runWindow(deps({ readiness: () => ({ state: "BLOCKED", blockers: ["OPERATOR_NOT_AUTHORIZED"] }) }), 300);
    expect(r).toEqual([{ stage: "READINESS", status: "HELD", reason: "EXECUTION_NOT_READY", detail: { blockers: ["OPERATOR_NOT_AUTHORIZED"] } }]);
  });
  it("collect → wait for finalized; then pay SOL in batches; rerun after crash → duplicates, no new payments", async () => {
    const subs: string[] = [];
    expect((await runWindow(deps({ vaultLamports: async () => 5n }, subs), 300)).at(-1)!.reason).toBe("AWAITING_FINALIZED_COLLECTION");
    const r1 = await runWindow(deps({}, subs), 300); expect(r1.at(-1)).toMatchObject({ stage: "PAY_SOL", reason: "AWAITING_FINALIZED_PAYOUTS", detail: { batches: 2, signed: 2 } });
    const n = subs.length; const r2 = await runWindow(deps({}, subs), 300);
    expect(r2.find((x) => x.stage === "PAY_SOL")!.status).toBe("DONE"); // duplicates only
    expect(subs.slice(n).filter((k) => k.includes("SOL"))).toHaveLength(2);
  });
  it("missing data and unsettled transactions wait; no evidence never buys", async () => {
    expect((await runWindow(deps({ vaultLamports: async () => null }), 300)).at(-1)!.reason).toBe("RPC_UNAVAILABLE");
    expect((await runWindow(deps({ openForCycle: async () => 1 }), 300)).at(-1)!.reason).toBe("UNSETTLED_TRANSACTIONS");
    expect((await runWindow(deps({ budget: async () => ({ sol: 0n, buyback: 5n, tokens: 0n, ops: 0n, evidence: false }) }), 300)).at(-1)!.reason).toBe("NO_FINALIZED_FEES_FOR_WINDOW");
    expect((await runWindow(deps({ pendingFills: async () => 1 }), 300)).at(-1)!.reason).toBe("FILL_NOT_YET_CAPTURED");
    expect((await runWindow(deps({ submit: async () => "NO_BUDGET" }), 300)).at(-1)).toMatchObject({ stage: "PAY_SOL", status: "HELD", reason: "NO_BUDGET" });
  });
});
