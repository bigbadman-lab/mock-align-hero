import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { decodeFeeEvents } from "@/lib/rewards/pump-events";
import { buildEligibility, branchEntitlements, TOKEN_PROGRAMS, type ExclusionConfig, type HolderAccount } from "@/lib/rewards/eligibility";
import { scanRecipient, type Rpc } from "@/lib/rewards/scanner";
import { ingest, memoryStore, type Expected } from "@/lib/rewards/ledger";
import t5MKt from "./fixtures/pump/5MKtaAm1.json";
import t4kX7 from "./fixtures/pump/4kX7mmrR.json";
import t5iYq from "./fixtures/pump/5iYqY4tD.json";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("real finalized Pump creator-fee transactions (mainnet fixtures)", () => {
  it("decodes collect_creator_fee_v2: 24,948,150 lamports to 6Vf3…NK2x at slot 456184057", () => {
    const d = decodeFeeEvents(t5MKt as never);
    expect(d.kind).toBe("OK");
    if (d.kind !== "OK") return;
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ slot: 456184057, source: "PUMP_CURVE_COLLECT", recipient: "6Vf3QXGdPm7os7p3UisqxVUVgSZswVK1wUDuVNikNK2x", amount: 24948150n, asset: "SOL", ixIndex: 2, eventIndex: 0 });
  });
  it("reconciles: recipient lamport delta = event amount − network fee it paid", () => {
    const tx = t5MKt as any; const d = decodeFeeEvents(tx); if (d.kind !== "OK") throw new Error();
    const i = tx.transaction.message.accountKeys.indexOf(d.events[0]!.recipient);
    expect(BigInt(tx.meta.postBalances[i] - tx.meta.preBalances[i])).toBe(d.events[0]!.amount - BigInt(tx.meta.fee));
  });
  it("legacy collect + empty AMM collect: only the curve event (1,596,035) is counted", () => {
    const d = decodeFeeEvents(t4kX7 as never);
    if (d.kind !== "OK") throw new Error(d.kind);
    expect(d.events.map((e) => [e.source, e.amount])).toEqual([["PUMP_CURVE_COLLECT", 1596035n]]);
  });
  it("collections with nothing to collect produce no events (not zero-amount credits)", () => {
    expect(decodeFeeEvents(t5iYq as never)).toEqual({ kind: "SKIP", reason: "no_fee_events" });
  });
  it("failed transaction is never credited", () => {
    const tx = clone(t5MKt) as any; tx.meta.err = { InstructionError: [2, "Custom"] };
    expect(decodeFeeEvents(tx)).toEqual({ kind: "SKIP", reason: "transaction_failed" });
  });
  it("missing transaction is UNKNOWN, not zero", () => {
    expect(decodeFeeEvents(null).kind).toBe("UNKNOWN");
  });
  it("event emitted without Pump's event authority is refused as forged", () => {
    const tx = clone(t5MKt) as any;
    for (const g of tx.meta.innerInstructions) for (const ix of g.instructions) if (ix.accounts.length === 1) ix.accounts = [0];
    expect(decodeFeeEvents(tx)).toEqual({ kind: "UNKNOWN", reason: "event_authority_mismatch" });
  });
  it("same bytes under a different program are ignored", () => {
    const tx = clone(t5MKt) as any; tx.transaction.message.accountKeys.push("Fake111111111111111111111111111111111111111");
    const idx = tx.transaction.message.accountKeys.length - 1;
    for (const g of tx.meta.innerInstructions) for (const ix of g.instructions) ix.programIdIndex = idx;
    expect(decodeFeeEvents(tx).kind).toBe("SKIP");
  });
  it("two events in one transaction get distinct event indexes and both credit once", async () => {
    const tx = clone(t5MKt) as any; const g = tx.meta.innerInstructions.find((x: any) => x.instructions.some((i: any) => i.accounts.length === 1));
    const evIx = g.instructions.find((i: any) => i.accounts.length === 1); g.instructions.push({ ...evIx });
    const d = decodeFeeEvents(tx); if (d.kind !== "OK") throw new Error();
    expect(d.events.map((e) => e.eventIndex)).toEqual([0, 1]);
    const s = memoryStore(); const exp: Expected = { programs: { PUMP_CURVE_COLLECT_V2: d.events[0]!.programId, PUMP_AMM_COLLECT_COIN_CREATOR: "x", PUMP_FEES_DISTRIBUTE_V2: "x" }, mint: "M", recipient: d.events[0]!.recipient, asset: "SOL" };
    const toObs = (e: (typeof d.events)[number]) => ({ signature: e.signature, ixIndex: e.ixIndex, eventIndex: e.eventIndex, source: "PUMP_CURVE_COLLECT_V2" as const, programId: e.programId, mint: "M", recipient: e.recipient, asset: e.asset, amount: e.amount, slot: e.slot, blockTime: e.blockTime!, commitment: "finalized" as const });
    for (const e of [...d.events, ...d.events]) await ingest(s, toObs(e), exp);
    expect([...s.events.values()].filter((v) => v.status === "CREDITED")).toHaveLength(2);
    expect((await ingest(s, { ...toObs(d.events[0]!), recipient: "Other", eventIndex: 9 }, exp)).kind).toBe("QUARANTINED");
  });
});

describe("bounded scanner", () => {
  const R = "6Vf3QXGdPm7os7p3UisqxVUVgSZswVK1wUDuVNikNK2x";
  const sig = (t: any) => ({ signature: t.transaction.signatures[0], slot: t.slot, err: t.meta.err, confirmationStatus: "finalized" });
  const rpc = (over: Partial<Rpc> = {}): Rpc => ({ async signatures() { return [sig(t5MKt)]; }, async transaction() { return t5MKt; }, ...over });
  it("finds the real event and advances the cursor", async () => {
    const r = await scanRecipient(rpc(), R, null);
    expect(r).toMatchObject({ kind: "OK", complete: true, newCursor: (t5MKt as any).transaction.signatures[0] });
    if (r.kind === "OK") expect(r.events).toHaveLength(1);
  });
  it("RPC outage is UNKNOWN and returns no events", async () => {
    expect((await scanRecipient(rpc({ async signatures() { throw new Error("rpc_down"); } }), R, null)).kind).toBe("UNKNOWN");
    expect((await scanRecipient(rpc({ async transaction() { return null; } }), R, null))).toMatchObject({ kind: "UNKNOWN", reason: "transaction_not_found" });
  });
  it("unfinalized signature in range blocks the whole scan", async () => {
    expect((await scanRecipient(rpc({ async signatures() { return [{ ...sig(t5MKt), confirmationStatus: "confirmed" }]; } }), R, null)).kind).toBe("UNKNOWN");
  });
  it("page cap reached: cursor does not advance past unseen history", async () => {
    const page = Array.from({ length: 100 }, () => sig(t5iYq));
    const r = await scanRecipient(rpc({ async signatures() { return page; }, async transaction() { return t5iYq; } }), R, "OLD");
    expect(r).toMatchObject({ kind: "OK", complete: false, newCursor: "OLD", scanned: 500 });
  });
});

describe("eligibility v1", () => {
  const MINT = "MCPmint", SPL = TOKEN_PROGRAMS.spl;
  const cfg: ExclusionConfig = { version: "v1-draft", approved: false, poolVaults: ["POOLVAULT"], treasuries: ["TREASURY"], reserves: [], resolvedOwners: {} };
  const acc = (account: string, owner: string, amount: bigint, o: Partial<HolderAccount> = {}): HolderAccount => ({ account, mint: MINT, tokenProgram: SPL, owner, amount, slot: 7, ownerKind: "WALLET", ...o });
  const snap = (accounts: HolderAccount[], totalSupply: bigint | null, c = cfg, extra = {}) => buildEligibility({ mint: MINT, slot: 7, commitment: "finalized", totalSupply, accounts, source: "test", ...extra }, c);

  it("aggregates SPL + Token-2022 accounts per owner; >0 is the only minimum; excludes pool, treasury, burn", () => {
    const s = snap([acc("a", "W1", 1n), acc("b", "W1", 4n, { tokenProgram: TOKEN_PROGRAMS.token2022 }), acc("c", "W2", 0n), acc("d", "POOLVAULT", 100n, { ownerKind: "PROGRAM" }), acc("e", "TREASURY", 50n), acc("f", "1nc1nerator11111111111111111111111111111111", 9n)], 164n);
    expect(s.holders).toEqual([{ owner: "W1", amount: 5n }]);
    expect(s.excludedTotal).toBe(159n);
    expect(s.status).toBe("COMPLETE");
    expect(s.livePayoutAllowed).toBe(false); // config not approved
  });
  it("program-owned, unknown, delegated and frozen holdings are flagged ambiguous, never silently assigned or dropped", () => {
    const s = snap([acc("a", "W1", 5n), acc("b", "PDA", 10n, { ownerKind: "PROGRAM" }), acc("c", "W3", 3n, { delegated: true }), acc("d", "U", 2n, { ownerKind: "UNKNOWN" })], 20n, { ...cfg, approved: true });
    expect(s.ambiguous.map((a) => a.why).sort()).toEqual(["delegated", "owner_program", "owner_unknown"]);
    expect(s.livePayoutAllowed).toBe(false);
    expect(s.reasons).toContain("ambiguous_holdings_need_review");
  });
  it("reviewed resolutions are honoured", () => {
    const s = snap([acc("a", "W1", 5n), acc("b", "ESCROW", 5n, { ownerKind: "PROGRAM" })], 10n, { ...cfg, approved: true, resolvedOwners: { ESCROW: "ELIGIBLE" } });
    expect(s.livePayoutAllowed).toBe(true);
    expect(s.holders.map((h) => h.owner)).toEqual(["ESCROW", "W1"]);
  });
  it("unreconciled or unknown supply is INCOMPLETE; mixed slots / foreign mint / unfinalized / historical are INVALID", () => {
    expect(snap([acc("a", "W1", 5n)], 6n).status).toBe("INCOMPLETE");
    expect(snap([acc("a", "W1", 5n)], null).status).toBe("INCOMPLETE");
    expect(snap([acc("a", "W1", 5n), acc("b", "W2", 1n, { slot: 8 })], 6n).reasons).toEqual(["mixed_slots"]);
    expect(snap([acc("a", "W1", 5n, { mint: "X" })], 5n).reasons).toEqual(["foreign_mint_account"]);
    expect(snap([acc("a", "W1", 5n)], 5n, cfg, { commitment: "confirmed" }).reasons).toEqual(["snapshot_not_finalized"]);
    expect(snap([acc("a", "W1", 5n)], 5n, cfg, { capturedForEpochAt: "HISTORICAL" }).status).toBe("INVALID");
  });
  it("LIVE entitlements BLOCKED until allowed; DRY_RUN conserves with carry", () => {
    const s = snap([acc("a", "A", 1n), acc("b", "B", 1n), acc("c", "C", 1n)], 3n);
    expect(branchEntitlements(s, 100n, "LIVE").kind).toBe("BLOCKED");
    const d = branchEntitlements(s, 100n, "DRY_RUN", 34n);
    if (d.kind !== "DRY_RUN") throw new Error();
    expect([...d.shares.values()].reduce((x, y) => x + y, 0n) + d.carry).toBe(100n);
  });
});

it("fixtures are genuine mainnet signatures (base58, 64 bytes)", () => {
  for (const t of [t5MKt, t4kX7, t5iYq] as any[]) expect(bs58.decode(t.transaction.signatures[0]).length).toBe(64);
});
