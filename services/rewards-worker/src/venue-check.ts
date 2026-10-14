// REWARDS-EXEC-01E — strict static validation of FEE_COLLECTION and BUYBACK messages before the deployer signs.
// Pure (no RPC). The message must be made only of these instruction shapes; anything else is refused:
//   compute budget      : one CU limit, one CU price (bounded by the caller)
//   ATA createIdempotent: payer = owner = deployer; mint ∈ {$MCP, WSOL}
//   system transfer     : BUYBACK only, deployer → deployer's own WSOL ATA (wrap), ≤ budget
//   token syncNative / closeAccount: deployer's own WSOL ATA only, rent/leftover back to the deployer
//   Pump / PumpSwap     : COLLECTION → collect_creator_fee / collect_coin_creator_fee;
//                         BUYBACK → buy (max_sol_cost) | buy_exact_sol_in | buy_exact_quote_in(_v2) (spendable_in),
//                         plus volume-accumulator bookkeeping; the buy must reference $MCP; total max spend ≤ budget.
// Real spend/fill are proven later from finalized balances (settlement.ts verifyFill) — this check only bounds risk.
import { createHash } from "node:crypto";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";
const SYS = "11111111111111111111111111111111", CB = "ComputeBudget111111111111111111111111111111";
const TOK = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOK22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const disc = (name: string) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
const D = Object.fromEntries(["collect_creator_fee", "collect_coin_creator_fee", "buy", "buy_exact_sol_in", "buy_exact_quote_in", "buy_exact_quote_in_v2",
  "sync_user_volume_accumulator", "init_user_volume_accumulator"].map((n) => [n, disc(n).join(",")])) as Record<string, string>;
const nameOf = (d: Uint8Array) => Object.entries(D).find(([, v]) => v === [...d.subarray(0, 8)].join(","))?.[0] ?? null;
const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const u32 = (d: Uint8Array, o: number) => Buffer.from(d).readUInt32LE(o);

export type Ix = { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array };
export type VenueOk = { ok: true; cuLimit: number; cuPrice: number; lamports: bigint; maxSpend: bigint; venue: "PUMP" | "PUMP_AMM" | null };
export function checkVenueTx(kind: "FEE_COLLECTION" | "BUYBACK", keys: readonly string[], ixs: readonly Ix[], me: string,
  x: { mint?: string | undefined; budgetLamports?: bigint | undefined; maxCuPrice: number }): VenueOk | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (kind === "BUYBACK" && (!x.mint || !x.budgetLamports || x.budgetLamports <= 0n)) return no("BUYBACK_BOUNDS_UNSET");
  const meWsol = getAssociatedTokenAddressSync(new PublicKey(WSOL), new PublicKey(me), false, new PublicKey(TOK)).toBase58();
  let cuLimit: number | null = null, cuPrice = 0, wrap = 0n, spend = 0n, collects = 0, buys = 0;
  let venue: VenueOk["venue"] = null;
  for (const ix of ixs) {
    const prog = keys[ix.programIdIndex]; const d = ix.data; const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    if (prog === CB) {
      if (d[0] === 2 && d.length === 5) { if (cuLimit !== null) return no("DUPLICATE_CU_LIMIT"); cuLimit = u32(d, 1); }
      else if (d[0] === 3 && d.length === 9) { const p = u64(d, 1); if (p > BigInt(x.maxCuPrice)) return no("CU_PRICE_TOO_HIGH"); cuPrice = Number(p); }
      else return no("COMPUTE_BUDGET_IX_NOT_ALLOWED");
    } else if (prog === ATA) {
      if (d.length !== 1 || d[0] !== 1 || acc[0] !== me || acc[2] !== me || !(acc[3] === WSOL || (x.mint && acc[3] === x.mint))) return no("ATA_IX_NOT_ALLOWED");
    } else if (prog === SYS) {
      if (kind !== "BUYBACK") return no("SYSTEM_IX_NOT_ALLOWED");
      if (d.length !== 12 || u32(d, 0) !== 2 || acc[0] !== me || acc[1] !== meWsol) return no("SYSTEM_IX_NOT_WRAP_TO_OWN_WSOL");
      wrap += u64(d, 4);
    } else if (prog === TOK || prog === TOK22) {
      if (d.length === 1 && d[0] === 17 && acc[0] === meWsol) continue; // syncNative
      if (d.length === 1 && d[0] === 9 && acc[0] === meWsol && acc[1] === me && acc[2] === me) continue; // closeAccount → deployer
      return no("TOKEN_IX_NOT_ALLOWED");
    } else if (prog === PUMP || prog === PUMP_AMM) {
      const n = d.length >= 8 ? nameOf(d) : null;
      if (!n) return no(`VENUE_IX_NOT_ALLOWED:${prog}`);
      if (n === "sync_user_volume_accumulator" || n === "init_user_volume_accumulator") { if (kind !== "BUYBACK") return no("VENUE_IX_NOT_ALLOWED"); continue; }
      if (kind === "FEE_COLLECTION") {
        if (n !== "collect_creator_fee" && n !== "collect_coin_creator_fee") return no(`VENUE_IX_NOT_ALLOWED:${n}`);
        if (!acc.includes(me)) return no("COLLECT_NOT_FOR_DEPLOYER");
        collects++; continue;
      }
      if (!n.startsWith("buy")) return no(`VENUE_IX_NOT_ALLOWED:${n}`);
      if (d.length < 24 || !acc.includes(x.mint!) || !acc.includes(me)) return no("BUY_SHAPE");
      const max = n === "buy" ? u64(d, 16) : u64(d, 8); const minOut = n === "buy" ? u64(d, 8) : u64(d, 16);
      if (minOut <= 0n) return no("BUY_MIN_OUT_ZERO");
      spend += max; buys++; venue = prog === PUMP ? "PUMP" : "PUMP_AMM";
    } else return no(`PROGRAM_NOT_ALLOWED:${prog ?? "?"}`);
  }
  if (cuLimit === null) return no("CU_LIMIT_MISSING");
  if (kind === "FEE_COLLECTION" && collects === 0) return no("NO_COLLECT_IX");
  if (kind === "BUYBACK") {
    if (buys !== 1) return no("EXACTLY_ONE_BUY_REQUIRED");
    if (spend > x.budgetLamports! || wrap > x.budgetLamports!) return no("BUY_EXCEEDS_BUDGET");
  }
  return { ok: true, cuLimit, cuPrice, lamports: kind === "BUYBACK" ? x.budgetLamports! : 0n, maxSpend: spend, venue };
}
