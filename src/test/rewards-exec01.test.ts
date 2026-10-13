// @vitest-environment node
import { describe, it, expect } from "vitest";
import { execute, reconcileOpen, memoryExecStore, batchId, type Chain, type Sender } from "../../services/rewards-worker/src/executor";
import { onboardMint, applyExclusions, splitDust, TOKEN_2022, PUMP_PROGRAM } from "../../services/rewards-worker/src/onboard";
import type { Plan, SignCtx } from "../../services/rewards-worker/src/signer";

const plan = (k = "intent-0001"): Plan => ({ kind: "SOL_PAYOUT", idempotencyKey: k, cycleId: "c1", epoch: 300, messageBase64: "", lastValidBlockHeight: 100, rows: [{ owner: "A", amount: 5n }] });
const ctx = {} as SignCtx;
let cur: ReturnType<typeof memoryExecStore> | null = null;
const okSign = async (p: Plan) => { await cur!.recordSigned(p.idempotencyKey, "SIG1", "BYTES1"); return { ok: true as const, signature: "SIG1", signedBase64: "BYTES1" }; };
const chain = (st: Chain["signatureStatus"] extends (s: string) => Promise<infer R> ? R : never, height: number | null, proof: Record<string, unknown> | null = { ok: 1 }): Chain =>
  ({ signatureStatus: async () => st, finalizedBlockHeight: async () => height, settlement: async () => proof });
const spySender = () => { const sent: string[] = []; const s: Sender = { send: async (b) => { sent.push(b); } }; return { s, sent }; };

describe("EXEC-01 executor", () => {
  it("broadcast disabled: signs, persists bytes, sends nothing", async () => {
    const st = (cur = memoryExecStore()); st.seed({ ...plan(), signature: "", signedBase64: "" } as never);
    const r = await execute(okSign, plan(), ctx, st, null);
    expect(r.state).toBe("SIGNED_HELD");
    expect(st.rows.get("intent-0001")!.signedBase64).toBe("BYTES1");
    expect(st.rows.get("intent-0001")!.sent).toBe(0);
  });
  it("bytes are persisted before send; a failing send never re-signs", async () => {
    const st = (cur = memoryExecStore()); st.seed({ ...plan() } as never);
    let signs = 0; const sign = async (p: Plan) => { signs++; return okSign(p); };
    const r = await execute(sign, plan(), ctx, st, { send: async () => { throw new Error("timeout"); } });
    expect(r.state).toBe("SENT"); expect(signs).toBe(1);
    await expect(execute(sign, plan(), ctx, st, null)).rejects.toThrow("intent_not_reserved");
  });
  it("crash after send: reconcile resends the SAME bytes while valid", async () => {
    const st = (cur = memoryExecStore()); st.seed({ ...plan() } as never); await execute(okSign, plan(), ctx, st, null);
    const { s, sent } = spySender();
    const steps = await reconcileOpen(st, chain({ status: "NOT_FOUND", slot: null }, 50), s);
    expect(steps[0]!.action).toBe("RESENT_SAME_BYTES"); expect(sent).toEqual(["BYTES1"]);
  });
  it("expiry only with finalized height past last valid height", async () => {
    const st = (cur = memoryExecStore()); st.seed({ ...plan() } as never); await execute(okSign, plan(), ctx, st, null);
    expect((await reconcileOpen(st, chain({ status: "UNKNOWN", slot: null }, 500), null))[0]!.action).toBe("WAIT");
    expect((await reconcileOpen(st, chain({ status: "NOT_FOUND", slot: null }, 100), null))[0]!.action).toBe("WAIT");
    expect((await reconcileOpen(st, chain({ status: "NOT_FOUND", slot: null }, 101), null))[0]!.action).toBe("EXPIRED_NOT_LANDED");
  });
  it("finalized ok without settlement proof is never LANDED", async () => {
    const st = (cur = memoryExecStore()); st.seed({ ...plan() } as never); await execute(okSign, plan(), ctx, st, null);
    expect((await reconcileOpen(st, chain({ status: "FINALIZED_OK", slot: 9 }, 10, null), null))[0]!.action).toBe("HELD_NO_PROOF");
    expect((await reconcileOpen(st, chain({ status: "FINALIZED_OK", slot: 9 }, 10), null))[0]!.action).toBe("LANDED");
    expect(await reconcileOpen(st, chain({ status: "FINALIZED_OK", slot: 9 }, 10), null)).toEqual([]); // settled stays settled
  });
  it("refuses without a validated signer", async () => {
    expect((await execute(null, plan(), ctx, memoryExecStore(), null)).state).toBe("REFUSED");
  });
  it("batch ids are deterministic and order-independent", () => {
    const a = [{ owner: "A", amount: 1n }, { owner: "B", amount: 2n }];
    expect(batchId("c", "SOL_PAYOUT", a)).toBe(batchId("c", "SOL_PAYOUT", [...a].reverse()));
    expect(batchId("c", "SOL_PAYOUT", a)).not.toBe(batchId("c", "SOL_PAYOUT", [{ owner: "A", amount: 1n }, { owner: "B", amount: 3n }]));
  });
});

describe("EXEC-01 onboarding + exclusions", () => {
  const good = { mint: "M", tokenProgram: TOKEN_2022, createdByProgram: PUMP_PROGRAM, creator: "D", quoteMint: "So11111111111111111111111111111111111111112", bondingCurve: "BC", poolVaults: [], holderRewardsBuiltIn: false };
  it("accepts a canonical SOL-paired Token-2022 Pump coin from the deployer", () => expect(onboardMint(good, "D").ok).toBe(true));
  it("rejects wrong mint program, creator, pairing and built-in rewards", () => {
    expect(onboardMint({ ...good, tokenProgram: "X" }, "D").blockers).toContain("WRONG_TOKEN_PROGRAM");
    expect(onboardMint(good, "OTHER").blockers).toContain("CREATOR_FEE_RECIPIENT_MISMATCH");
    expect(onboardMint({ ...good, quoteMint: "USDC" }, "D").blockers).toContain("NOT_SOL_PAIRED");
    expect(onboardMint({ ...good, holderRewardsBuiltIn: null }, "D").blockers).toContain("BUILTIN_HOLDER_REWARDS_NOT_OFF");
  });
  it("excludes deployer/curve and pauses on unknown program owners", () => {
    const r = applyExclusions([{ owner: "D", amount: 1n, kind: "WALLET" }, { owner: "BC", amount: 1n, kind: "PROGRAM" }, { owner: "W", amount: 2n, kind: "WALLET" }], { deployer: "D", bondingCurve: "BC", poolVaults: [] });
    expect(r).toEqual({ kind: "OK", eligible: [{ owner: "W", amount: 2n }], excluded: ["D", "BC"] });
    expect(applyExclusions([{ owner: "P", amount: 1n, kind: "PROGRAM" }], { deployer: "D", bondingCurve: null, poolVaults: [] }).kind).toBe("HELD");
  });
  it("dust carries forward", () => expect(splitDust([{ owner: "a", amount: 3n }, { owner: "b", amount: 10n }], 5n)).toEqual({ pay: [{ owner: "b", amount: 10n }], carry: [{ owner: "a", amount: 3n }] }));
});
