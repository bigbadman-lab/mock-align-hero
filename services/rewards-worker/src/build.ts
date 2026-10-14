// REWARDS-EXEC-01E — build → validate → sign → persist for every stage of the five-minute cycle. WORKER-ONLY.
// Uses the mainnet-simulated assembly paths (assembly.ts). Sender is injected; the worker passes null in this gate,
// so signed bytes are persisted and HELD (BROADCAST_NOT_ENABLED) — nothing is sent.
import { Connection, PublicKey } from "@solana/web3.js";
import { assemble, collectionInstructions, ammCollectInstructions, curveBuyInstructions, ammBuyInstructions, solPayoutIxs, tokenPayoutIxs, mintTokenProgram } from "./assembly";
import { execute, type ExecStore, type Sender } from "./executor";
import type { Plan, SignCtx, SignResult } from "./signer";
import type { SubmitOutcome } from "./orchestrator";

import { BUY_SLIPPAGE_BPS, curveInputFor } from "./venue-check";
export { BUY_SLIPPAGE_BPS, curveInputFor };
const CU = { FEE_COLLECTION: 200_000, BUYBACK: 250_000, SOL_PAYOUT: 50_000, TOKEN_PAYOUT: 400_000 } as const;

export type BuildDeps = {
  conn: Connection; deployer: PublicKey; mint: PublicKey; decimals: number; cuPrice: number;
  sign: ((p: Plan, c: SignCtx) => Promise<SignResult>) | null; ctx: () => Promise<SignCtx>; store: ExecStore; sender: Sender | null;
};


export async function submitStage(d: BuildDeps, kind: "FEE_COLLECTION" | "BUYBACK" | "SOL_PAYOUT" | "TOKEN_PAYOUT", key: string, cycleId: string, window: number,
  rows: { owner: string; amount: bigint }[], lamports: bigint): Promise<SubmitOutcome> {
  if (!d.sign) return "REFUSED";
  try {
    let ixs;
    if (kind === "FEE_COLLECTION") {
      // Unaccounted WSOL already in the deployer's WSOL account would be swept by the unwrap → refuse (never "income").
      const w = await d.conn.getTokenAccountBalance((require("@solana/spl-token") as typeof import("@solana/spl-token")).getAssociatedTokenAddressSync(
        new PublicKey("So11111111111111111111111111111111111111112"), d.deployer), "finalized").then((b) => BigInt(b.value.amount)).catch(() => 0n);
      if (w !== 0n) return "REFUSED";
      const curve = await collectionInstructions(d.conn, d.deployer).catch(() => null);
      const amm = curve ? null : await ammCollectInstructions(d.conn, d.deployer);
      ixs = curve?.ixs ?? (amm?.kind === "OK" ? amm.ixs : null);
    } else if (kind === "BUYBACK") {
      const prog = await mintTokenProgram(d.conn, d.mint);
      const c = await curveBuyInstructions(d.conn, d.mint, d.deployer, { budgetLamports: curveInputFor(lamports), maxSlippageBps: BUY_SLIPPAGE_BPS, minOutTokens: 1n }, prog);
      const a = c.kind === "OK" ? null : c.reason.startsWith("CURVE_COMPLETE") ? await ammBuyInstructions(d.conn, d.mint, d.deployer, { budgetLamports: lamports, maxSlippageBps: BUY_SLIPPAGE_BPS, minOutTokens: 1n }) : null;
      ixs = c.kind === "OK" ? c.ixs : a?.kind === "OK" ? a.ixs : null;
    } else if (kind === "SOL_PAYOUT") ixs = solPayoutIxs(d.deployer, rows.map((r) => ({ owner: r.owner, lamports: r.amount })));
    else {
      const prog = await mintTokenProgram(d.conn, d.mint);
      const infos = await d.conn.getMultipleAccountsInfo(rows.map((r) => (require("@solana/spl-token") as typeof import("@solana/spl-token")).getAssociatedTokenAddressSync(d.mint, new PublicKey(r.owner), true, prog)), "finalized");
      ixs = tokenPayoutIxs(d.deployer, d.mint, d.decimals, rows.map((r, i) => ({ owner: r.owner, amount: r.amount, ataExists: !!infos[i] })), prog);
    }
    if (!ixs) return "REFUSED";
    const bh = await d.conn.getLatestBlockhash("finalized");
    const u = assemble(ixs as never, d.deployer, bh, { cuLimit: CU[kind], cuPriceMicroLamports: d.cuPrice, allowedSigners: [d.deployer.toBase58()] });
    if (u.kind !== "UNSIGNED") return "REFUSED";
    const plan: Plan = { kind, idempotencyKey: key, cycleId, epoch: window, messageBase64: u.messageBase64, lastValidBlockHeight: u.lastValidBlockHeight, rows,
      mint: d.mint.toBase58(), decimals: d.decimals, ...(kind === "BUYBACK" ? { budgetLamports: lamports } : {}) };
    const o = await execute(d.sign, plan, await d.ctx(), d.store, d.sender);
    if (o.state === "REFUSED") return o.reason === "DUPLICATE_INTENT" ? "DUPLICATE" : o.reason.startsWith("NO_") ? "NO_BUDGET" : "REFUSED";
    return "NEW_SIGNED";
  } catch { return "REFUSED"; }
}
