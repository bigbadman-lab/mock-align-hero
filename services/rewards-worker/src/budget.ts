// Fee-backed spending authority (worker-side, pure). Budgets come ONLY from finalized, mint-attributable Pump.fun
// creator-fee collections paid to the canonical deployer (30 SOL holders / 30 buyback / 40 operations, via the
// ledger's split303040) and from finalized buyback fills — never from wallet balances, quotes or client input.
import { split303040 } from "../../../src/lib/rewards/native-single";
import type { IntentStore, PlanKind, ReserveResult } from "./signer";

export type FeeRecord = { eventKey: string; mint: string; recipient: string; amount: bigint; epoch: number; commitment: "finalized" | string; status: "CREDITED" | string };
export type FillRecord = { signature: string; mint: string; epoch: number; tokens: bigint; solSpent: bigint; decimals: number; finalized: boolean };
export type EpochBudget = { sol: bigint; buyback: bigint; ops: bigint; tokens: bigint };

/** Derive per-epoch budgets. Anything not provably ours is ignored (unrelated deposits never appear as fee records). */
export function deriveBudgets(cfg: { mint: string; deployer: string; decimals: number }, fees: readonly FeeRecord[], fills: readonly FillRecord[]) {
  const out = new Map<number, EpochBudget>(); const seen = new Set<string>(); const rejected: string[] = [];
  const get = (e: number) => { let b = out.get(e); if (!b) out.set(e, (b = { sol: 0n, buyback: 0n, ops: 0n, tokens: 0n })); return b; };
  for (const f of fees) {
    if (seen.has(f.eventKey)) { rejected.push(`${f.eventKey}:DUPLICATE`); continue; }
    if (f.status !== "CREDITED" || f.commitment !== "finalized") { rejected.push(`${f.eventKey}:NOT_FINALIZED_CREDITED`); continue; }
    if (f.mint !== cfg.mint) { rejected.push(`${f.eventKey}:WRONG_MINT`); continue; }
    if (f.recipient !== cfg.deployer) { rejected.push(`${f.eventKey}:WRONG_CREATOR`); continue; }
    seen.add(f.eventKey);
    const s = split303040(f.amount); const b = get(f.epoch);
    if (s.solBudget + s.buybackBudget + s.operations !== f.amount) throw new Error("split_not_conserved");
    b.sol += s.solBudget; b.buyback += s.buybackBudget; b.ops += s.operations;
  }
  const fillSeen = new Set<string>();
  for (const x of fills) {
    if (fillSeen.has(x.signature) || !x.finalized || x.mint !== cfg.mint || x.decimals !== cfg.decimals || x.tokens <= 0n) { rejected.push(`${x.signature}:FILL_REJECTED`); continue; }
    const b = out.get(x.epoch);
    if (!b || x.solSpent > b.buyback) { rejected.push(`${x.signature}:FILL_UNBACKED`); continue; }
    fillSeen.add(x.signature); b.tokens += x.tokens; // tokens actually received, never a quote
  }
  return { budgets: out, rejected };
}

/** Real balances must cover everything still owed; otherwise hold (external spend / shortfall). Deposits never add budget. */
export function balanceCheck(x: { solBalance: bigint | null; tokenBalance: bigint | null; rentExemptMin: bigint; unpaidSol: bigint; unspentBuyback: bigint; opsReserved: bigint; unpaidTokens: bigint }) {
  if (x.solBalance === null || x.tokenBalance === null) return { ok: false as const, reason: "BALANCE_UNKNOWN" };
  if (x.solBalance < x.rentExemptMin + x.unpaidSol + x.unspentBuyback + x.opsReserved) return { ok: false as const, reason: "SOL_SHORTFALL" };
  if (x.tokenBalance < x.unpaidTokens) return { ok: false as const, reason: "TOKEN_SHORTFALL" };
  return { ok: true as const };
}

/** Large epochs are split into many compliant transactions — never blocked by a financial ceiling. Stable ids per chunk. */
export function chunkEntitlements<T extends { owner: string }>(epoch: number, kind: PlanKind, rows: readonly T[], perTx: number) {
  if (!(perTx >= 1 && perTx <= 20)) throw new Error("per_tx_out_of_range");
  const sorted = [...rows].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const out: { idempotencyKey: string; rows: T[] }[] = [];
  for (let i = 0; i < sorted.length; i += perTx) out.push({ idempotencyKey: `${kind}:${epoch}:${i / perTx}`, rows: sorted.slice(i, i + perTx) });
  return out;
}

const FREED = new Set(["EXPIRED_NOT_LANDED", "ABANDONED_UNSIGNED", "FAILED_ON_CHAIN"]);
/** In-memory reference store with the SAME rules as the SQL store (tests / local probes only). */
export function memoryBudgetStore(budgets: Map<number, EpochBudget>, opsCarry = 0n) {
  type R = { cycleId: string; kind: PlanKind; epoch: number; lamports: bigint; tokens: bigint; ops: bigint; state: string; signature?: string };
  const rows = new Map<string, R>();
  const live = () => [...rows.values()].filter((r) => !FREED.has(r.state));
  const store: IntentStore & { rows: typeof rows; setState(k: string, s: string): void } = {
    rows,
    setState(k, st) { rows.get(k)!.state = st; },
    async reserve(i): Promise<ReserveResult> {
      if (rows.has(i.idempotencyKey)) return "DUPLICATE";
      const b = budgets.get(i.epoch); if (!b) return "NO_EVIDENCE";
      const used = live().filter((r) => r.epoch === i.epoch);
      const sum = (k: PlanKind, f: (r: R) => bigint) => used.filter((r) => r.kind === k).reduce((a, r) => a + f(r), 0n);
      if (i.kind === "SOL_PAYOUT" && sum("SOL_PAYOUT", (r) => r.lamports) + i.lamports > b.sol) return "NO_SOL_BUDGET";
      if (i.kind === "BUYBACK" && sum("BUYBACK", (r) => r.lamports) + i.lamports > b.buyback) return "NO_BUYBACK_BUDGET";
      if (i.kind === "TOKEN_PAYOUT" && (i.lamports !== 0n || sum("TOKEN_PAYOUT", (r) => r.tokens) + i.tokens > b.tokens)) return "NO_TOKEN_BUDGET";
      let opsTotal = opsCarry; for (const x of budgets.values()) opsTotal += x.ops;
      if (live().reduce((a, r) => a + r.ops, 0n) + i.opsCostLamports > opsTotal) return "NO_OPS_RESERVE";
      rows.set(i.idempotencyKey, { cycleId: i.cycleId, kind: i.kind, epoch: i.epoch, lamports: i.lamports, tokens: i.tokens, ops: i.opsCostLamports, state: "RESERVED" });
      return "NEW";
    },
    async cycleSpent(c) { return live().filter((r) => r.cycleId === c).reduce((a, r) => a + r.lamports, 0n); },
    async recordSigned(k, sig, _b64) { const r = rows.get(k); if (!r || r.state !== "RESERVED") throw new Error("intent_not_reserved"); r.state = "SIGNED"; r.signature = sig; },
  };
  return store;
}
