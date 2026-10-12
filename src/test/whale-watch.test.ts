// MOCK-ONLY unit tests (injected fake RPC). Never counted as live chain evidence.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS worker module
import { watchWhales, extractTransfers, validInput } from "../../services/mcp-worker/src/whale.mjs";
import { isWhaleWatchResult } from "@/lib/tools/whale-watch";

const ME = "So11111111111111111111111111111111111111112";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYS = "11111111111111111111111111111111";
const ONE = 1_000_000_000;
const xfer = (source: string, destination: string, lamports: number, type = "transfer") => ({ programId: SYS, parsed: { type, info: { source, destination, lamports } } });
const tx = (ixs: unknown[], meta: Record<string, unknown> | null = { err: null }, slot = 100) => ({ slot, blockTime: 1760000000, transaction: { message: { instructions: ixs } }, meta });
const res = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });

function run(sigCount: number, txFor: (i: number) => Response, opts: { sigs?: Response; budgetMs?: number } = {}) {
  let inFlight = 0, maxInFlight = 0, calls = 0;
  const fetchImpl = async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    calls++;
    if (b.method === "getSignaturesForAddress") return opts.sigs ?? res(Array.from({ length: sigCount }, (_, i) => ({ signature: `sig${i}`, slot: 1000 - i })));
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return txFor(Number(b.params[0].slice(3)));
  };
  return watchWhales({ address: ME, minLamports: "1000000000", rpcUrl: "https://rpc.invalid", executionId: "x", fetchImpl, budgetMs: opts.budgetMs, now: () => new Date("2026-01-01T00:00:00Z") })
    .then((r: unknown) => ({ r: r as Record<string, any>, calls, maxInFlight }));
}

describe("Whale Watch (mock RPC)", () => {
  it("accepts only an address plus one of four fixed thresholds", () => {
    expect(validInput({ address: ME, minLamports: "1000000000" })).toBe(true);
    expect(validInput({ address: ME, minLamports: "5" })).toBe(false);
    expect(validInput({ address: ME, minLamports: "1000000000", limit: 50 })).toBe(false);
    expect(validInput({ address: "nope", minLamports: "1000000000" })).toBe(false);
  });
  it("IN / OUT / SELF, inner transfers, threshold boundary, ignores unrelated and non-transfer instructions", () => {
    const t = { ...tx([xfer(OTHER, ME, ONE), xfer(ME, OTHER, ONE - 1), xfer(ME, ME, 5 * ONE), xfer(OTHER, SYS, 9 * ONE), { programId: SYS, parsed: { type: "createAccount", info: {} } }, { programId: OTHER, data: "abc" }]), meta: { err: null, innerInstructions: [{ index: 5, instructions: [xfer(ME, OTHER, 2 * ONE, "transferWithSeed")] }] } };
    const { transfers, undecodable } = extractTransfers(t, ME, "s");
    expect(undecodable).toBe(0);
    expect(transfers.map((x: any) => [x.direction, x.lamports, x.innerIndex])).toEqual([["IN", "1000000000", null], ["OUT", "999999999", null], ["SELF", "5000000000", null], ["OUT", "2000000000", 0]]);
  });
  it("caps: 20 signatures seen, 10 inspected, max 2 concurrent, 11 reads total, filtered by exact threshold", async () => {
    const { r, calls, maxInFlight } = await run(20, (i) => res(tx([xfer(OTHER, ME, i % 2 ? ONE : ONE - 1)], { err: null }, 1000 - i)));
    expect(calls).toBe(11);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(r.coverage).toMatchObject({ signaturesSeen: 20, transactionsAttempted: 10, transactionsDecoded: 10, notInspected: 10 });
    expect(r.transfers).toHaveLength(5);
    expect(r.transfers[0].slot).toBeGreaterThan(r.transfers[4].slot);
    expect(r.complete).toBe(true);
    expect(isWhaleWatchResult(r, ME, "1000000000")).toBe(true);
  });
  it("failed transactions never count as moved SOL; missing meta / null / unsupported version make the sample partial", async () => {
    const { r } = await run(4, (i) => [res(tx([xfer(OTHER, ME, 50 * ONE)], { err: { InstructionError: [0, "X"] } })), res(tx([xfer(OTHER, ME, 50 * ONE)], null)), res(null), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32015 } }))][i]);
    expect(r.transfers).toHaveLength(0);
    expect(r.coverage).toMatchObject({ failedTransactions: 1, unavailableTransactions: 2, unsupportedVersion: 1 });
    expect(r.complete).toBe(false);
  });
  it("undecodable System instruction marks partial; zero signatures is a complete empty sample", async () => {
    const a = await run(1, () => res(tx([{ programId: SYS, data: "raw" }])));
    expect(a.r.coverage.partiallyDecoded).toBe(1);
    expect(a.r.complete).toBe(false);
    const b = await run(0, () => res(null));
    expect(b.r).toMatchObject({ complete: true, transfers: [] });
  });
  it("signature listing failure is an error, never an empty result", async () => {
    await expect(run(0, () => res(null), { sigs: new Response("x", { status: 429 }) })).rejects.toMatchObject({ kind: "rate_limited" });
  });
  it("time budget truncation is reported", async () => {
    const { r } = await run(10, () => res(tx([])), { budgetMs: 0 });
    expect(r.coverage.truncatedByBudget).toBe(10);
    expect(r.complete).toBe(false);
  });
});
