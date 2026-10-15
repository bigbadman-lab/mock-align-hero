// One-time pre-mint SOL payout rehearsal (approved Oct 15 2026). WORKER-ONLY.
// Exercises the real payout path: assembly → signer validation (exact rows) → persisted bytes → rpc sender → finalized
// balance-delta proof. Fixed recipients + fixed amount, hard total cap, runs only while the $MCP mint is unset and only
// with MCPX_PAYOUT_REHEARSAL=1. Once-only is proven ON CHAIN: if the deployer already paid these exact rows, it never sends.
import { Connection, PublicKey } from "@solana/web3.js";
import { assemble, solPayoutIxs } from "./assembly";
import { TECHNICAL_LIMITS, type IntentStore, type Plan, type SignCtx, type SignResult } from "./signer";
import type { Sender } from "./executor";

export const REHEARSAL_RECIPIENTS = [
  "2PjjmwZVumHY1ppEP1EnE1jHqGNNb7xW1jcSdKbNkUrP",
  "6BPBhS5MrDwke7EZ66EkzbPpbHQ3wmrdX3XMGixKiYW8",
  "A3ErRDE9VTiMYGMykdJo3e2zUiRqveRwuUtD95Afm3qB",
] as const;
export const REHEARSAL_LAMPORTS_EACH = 1_000_000n; // 0.001 SOL
export const REHEARSAL_TOTAL_CAP = 3_000_000n;

/** Does this finalized tx pay exactly REHEARSAL_LAMPORTS_EACH from the deployer to every recipient? */
export function isRehearsalTx(t: { keys: string[]; pre: number[]; post: number[]; err: unknown }, deployer: string) {
  if (t.err || t.keys[0] !== deployer) return false;
  return REHEARSAL_RECIPIENTS.every((r) => { const i = t.keys.indexOf(r); return i > 0 && BigInt(t.post[i]! - t.pre[i]!) === REHEARSAL_LAMPORTS_EACH; });
}

type Tx = { keys: string[]; pre: number[]; post: number[]; err: unknown; slot: number };
async function readTx(conn: Connection, sig: string): Promise<Tx | null> {
  const t = await conn.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 1 });
  if (!t?.meta) return null;
  return { keys: t.transaction.message.staticAccountKeys.map((k) => k.toBase58()), pre: t.meta.preBalances, post: t.meta.postBalances, err: t.meta.err, slot: t.slot };
}

/** Earlier rehearsal on chain? Scans the first recipient's recent finalized history. */
async function priorRehearsal(conn: Connection, deployer: string) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(REHEARSAL_RECIPIENTS[0]), { limit: 50 }, "finalized");
  for (const s of sigs) { if (s.err) continue; const t = await readTx(conn, s.signature); if (t && isRehearsalTx(t, deployer)) return { signature: s.signature, slot: t.slot }; }
  return null;
}

let doneThisProcess = false;
export async function runPayoutRehearsal(d: { conn: Connection; deployer: string | null; mintSet: boolean; enabled: boolean;
  sign: ((p: Plan, c: SignCtx) => Promise<SignResult>) | null; sender: Sender | null; log: (o: Record<string, unknown>) => void }) {
  const L = (o: Record<string, unknown>) => d.log({ event: "payout_rehearsal", ...o });
  if (!d.enabled || doneThisProcess) return;
  if (d.mintSet) return L({ state: "SKIPPED", reason: "MINT_SET" });
  if (!d.deployer) return L({ state: "BLOCKED", reason: "DEPLOYER_UNSET" });
  if (!d.sign) return L({ state: "BLOCKED", reason: "SIGNER_NOT_VALIDATED" });
  if (!d.sender) return L({ state: "BLOCKED", reason: "BROADCAST_DISABLED" });
  try {
    const prior = await priorRehearsal(d.conn, d.deployer);
    if (prior) { doneThisProcess = true; return L({ state: "ALREADY_LANDED", ...prior }); }
    const rows = REHEARSAL_RECIPIENTS.map((owner) => ({ owner, amount: REHEARSAL_LAMPORTS_EACH }));
    const total = rows.reduce((a, r) => a + r.amount, 0n);
    if (total > REHEARSAL_TOTAL_CAP) return L({ state: "BLOCKED", reason: "CAP" });
    const deployer = new PublicKey(d.deployer);
    const bal = BigInt(await d.conn.getBalance(deployer, "finalized"));
    if (bal < total + 1_000_000n) return L({ state: "BLOCKED", reason: "DEPLOYER_BALANCE_LOW", balance: String(bal) });
    const bh = await d.conn.getLatestBlockhash("finalized");
    const u = assemble(solPayoutIxs(deployer, rows.map((r) => ({ owner: r.owner, lamports: r.amount }))), deployer, bh, { cuLimit: 50_000, cuPriceMicroLamports: 1000, allowedSigners: [d.deployer] });
    if (u.kind !== "UNSIGNED") return L({ state: "BLOCKED", reason: u.reason });
    // Rehearsal-only intent store: single key, hard cap, records bytes before send.
    let reserved = false, recorded = false;
    const store: IntentStore = {
      async reserve(i) { if (reserved) return "DUPLICATE"; if (i.lamports !== total || i.lamports > REHEARSAL_TOTAL_CAP) return "NO_SOL_BUDGET"; reserved = true; return "NEW"; },
      async cycleSpent() { return 0n; },
      async recordSigned() { recorded = true; },
    };
    const epoch = Math.floor(Date.now() / 300_000) * 300;
    const plan: Plan = { kind: "SOL_PAYOUT", idempotencyKey: "payout-rehearsal-1", cycleId: "payout-rehearsal", epoch, messageBase64: u.messageBase64, lastValidBlockHeight: u.lastValidBlockHeight, rows };
    const s = await d.sign(plan, { limits: { maxLamportsPerTx: REHEARSAL_TOTAL_CAP, maxLamportsPerCycle: null, maxTokensPerTx: null, ...TECHNICAL_LIMITS },
      emergencyStop: false, currentBlockHeight: await d.conn.getBlockHeight("finalized"), store });
    if (!s.ok || !recorded) return L({ state: "REFUSED", reason: s.ok ? "NOT_RECORDED" : s.reason });
    doneThisProcess = true; // never sign again in this process, whatever happens next
    L({ state: "SIGNED", signature: s.signature, total: String(total) });
    try { await d.sender.send(s.signedBase64); } catch (e) { L({ state: "SEND_ERROR", error: e instanceof Error ? e.message.slice(0, 160) : "unknown" }); }
    for (let i = 0; i < 24; i++) { // up to ~2 min for finality; same bytes only, never re-signed
      await new Promise((r) => setTimeout(r, 5000));
      const t = await readTx(d.conn, s.signature).catch(() => null);
      if (!t) { if (i % 4 === 3) await d.sender.send(s.signedBase64).catch(() => {}); continue; }
      return L({ state: isRehearsalTx(t, d.deployer) ? "LANDED_PROVEN" : "LANDED_MISMATCH", signature: s.signature, slot: t.slot, err: t.err ?? null });
    }
    L({ state: "NOT_FINALIZED_YET", signature: s.signature });
  } catch (e) { L({ state: "ERROR", error: e instanceof Error ? e.message.slice(0, 160) : "unknown" }); }
}
