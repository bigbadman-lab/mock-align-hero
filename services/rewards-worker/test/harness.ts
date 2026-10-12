// Multi-process proof harness (throwaway DB only). One OS process = one worker run.
import postgres from "postgres";
import { ingestDistribution, processNext, type NativeConfig } from "../../../src/lib/rewards/processor";
import { pgStore, type Db } from "../../../src/lib/rewards/store.pg";
import { buildEligibility } from "../../../src/lib/rewards/eligibility";
const [, , mode, workerId, nowArg] = process.argv;
const T0 = 1_800_000_000 - (1_800_000_000 % 300), now = Number(nowArg ?? T0 + 400);
const CFG: NativeConfig = { mint: "FIXTURE_MINT", sharingConfig: "FIXTURE_SHARING", rewardsTreasury: "FIXTURE_REWARDS", operationsTreasury: "FIXTURE_OPS", finalityLagSeconds: 30, minPayableLamports: 1n };
const sql = postgres(process.env["MCPX_TEST_PG_URL"]!, { max: 1, onnotice: () => {} });
const db: Db = { query: async (t, p) => ({ rows: (await sql.unsafe(t, (p ?? []) as never[])) as never }) };
const store = pgStore(db, workerId!, 10, { programId: "pfee", mint: "FIXTURE_MINT", sharingConfig: "FIXTURE_SHARING", rewardsRecipient: "FIXTURE_REWARDS", operationsRecipient: "FIXTURE_OPS" });
if (mode === "ingest") {
  const r = await ingestDistribution(store, CFG, { signature: "5".repeat(88), slot: 9, blockTime: T0 + 5, ixIndex: 0, eventIndex: 0, mint: "FIXTURE_MINT", bondingCurve: "b", sharingConfig: "FIXTURE_SHARING", creatorVault: "v", admin: "a", quoteMint: "11111111111111111111111111111111", distributed: 1000001n, asset: "SOL",
    receipts: [{ address: "FIXTURE_REWARDS", shareBps: 6000, lamports: 600001n }, { address: "FIXTURE_OPS", shareBps: 4000, lamports: 400000n }] }, true);
  console.log(JSON.stringify({ pid: process.pid, ingest: r.kind })); await sql.end(); process.exit(0);
}
const snapshot = async () => buildEligibility({ mint: "FIXTURE_MINT", slot: 200, commitment: "finalized", totalSupply: 4n, source: "fixture",
  accounts: [["alice", 3n], ["bob", 1n]].map(([o, a], i) => ({ account: `acct${i}`, mint: "FIXTURE_MINT", tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", owner: o as string, amount: a as bigint, slot: 200, ownerKind: "WALLET" as const })) },
  { version: "fx-1", approved: true, poolVaults: [], treasuries: [], reserves: [], resolvedOwners: {} });
const r = await processNext(store, CFG, { workerId: workerId!, now, leaseSeconds: 10, finalizedBlockTime: now, genesisWindow: T0,
  snapshot: async (e) => { if (mode === "die") { console.log(JSON.stringify({ pid: process.pid, event: "SIGKILL_self_holding_lease" })); process.kill(process.pid, "SIGKILL"); } return snapshot(); },
  costs: () => ({ estimateLamports: 1n, reserveLamports: 10n }) });
console.log(JSON.stringify({ pid: process.pid, workerId, result: r.kind, planId: r.kind === "SEALED" ? r.plan.planId : undefined, window: r.kind === "SEALED" ? r.plan.window : undefined }));
await sql.end();
