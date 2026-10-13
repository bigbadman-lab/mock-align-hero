// REWARDS-EXEC-01 E04 — durable executor. WORKER-ONLY.
// reserve → sign → PERSIST signed bytes → send → poll → finalized proof. The sender is injected; in this gate the
// worker passes `null`, so nothing is ever broadcast (BROADCAST_NOT_ENABLED). A crash after persisting can only
// resend the SAME bytes while the blockhash is valid — a new signature is never produced for an ambiguous outcome.
import { createHash } from "node:crypto";
import { reconcile, type Plan, type SignCtx, type SignResult } from "./signer";

export type ChainStatus = { status: "FINALIZED_OK" | "FINALIZED_ERR" | "NOT_FOUND" | "UNKNOWN"; slot: number | null };
export type Chain = {
  signatureStatus(sig: string): Promise<ChainStatus>;
  finalizedBlockHeight(): Promise<number | null>;
  /** Exact settlement proof from the finalized tx (balance deltas). Null = cannot prove → never LANDED. */
  settlement(sig: string, plan: { kind: string; idempotencyKey?: string; rows: readonly { owner: string; amount: bigint }[]; mint?: string }): Promise<Record<string, unknown> | null>;
};
export type Sender = { send(signedBase64: string): Promise<void> };
export type OpenIntent = { idempotencyKey: string; kind: string; signature: string; signedBase64: string; lastValidBlockHeight: number;
  rows: readonly { owner: string; amount: bigint }[]; mint?: string };
export type ExecStore = {
  markSent(key: string): Promise<void>;
  finalize(key: string, outcome: "LANDED" | "FAILED_ON_CHAIN" | "EXPIRED_NOT_LANDED", slot: number, evidence: Record<string, unknown>): Promise<boolean>;
  openSigned(): Promise<OpenIntent[]>;
};

/** Deterministic batch id: same cycle + kind + sorted rows → same id across restarts and workers. */
export function batchId(cycleId: string, kind: string, rows: readonly { owner: string; amount: bigint }[]) {
  const body = [...rows].sort((a, b) => (a.owner < b.owner ? -1 : 1)).map((r) => `${r.owner}:${r.amount}`).join(",");
  return `${kind}:${createHash("sha256").update(`${cycleId}|${kind}|${body}`).digest("hex").slice(0, 40)}`;
}

export type ExecOutcome = { state: "REFUSED"; reason: string } | { state: "SIGNED_HELD"; reason: "BROADCAST_NOT_ENABLED"; signature: string }
  | { state: "SENT"; signature: string };

export async function execute(sign: ((p: Plan, c: SignCtx) => Promise<SignResult>) | null, plan: Plan, ctx: SignCtx, store: ExecStore, sender: Sender | null): Promise<ExecOutcome> {
  if (!sign) return { state: "REFUSED", reason: "SIGNER_NOT_VALIDATED" };
  // signer.ts reserves durably BEFORE signing and persists SIGNED + exact bytes BEFORE returning (no bytes saved → refused)
  const s = await sign(plan, ctx);
  if (!s.ok) return { state: "REFUSED", reason: s.reason };
  if (!sender) return { state: "SIGNED_HELD", reason: "BROADCAST_NOT_ENABLED", signature: s.signature };
  await store.markSent(plan.idempotencyKey);
  try { await sender.send(s.signedBase64); } catch { /* ambiguous: reconcile decides; never re-sign */ }
  return { state: "SENT", signature: s.signature };
}

export type ReconcileStep = { key: string; action: "LANDED" | "FAILED_ON_CHAIN" | "EXPIRED_NOT_LANDED" | "RESENT_SAME_BYTES" | "WAIT" | "HELD_NO_PROOF" };

/** Crash-safe recovery of every SIGNED intent. Settled batches stay settled; only unsettled ones are touched. */
export async function reconcileOpen(store: ExecStore, chain: Chain, sender: Sender | null): Promise<ReconcileStep[]> {
  const out: ReconcileStep[] = [];
  const height = await chain.finalizedBlockHeight();
  for (const i of await store.openSigned()) {
    const st = await chain.signatureStatus(i.signature);
    const d = reconcile(i, { status: st.status, finalizedBlockHeight: height });
    if (d === "LANDED") {
      const proof = st.slot === null ? null : await chain.settlement(i.signature, i);
      if (!proof) { out.push({ key: i.idempotencyKey, action: "HELD_NO_PROOF" }); continue; }
      await store.finalize(i.idempotencyKey, "LANDED", st.slot!, { signature: i.signature, ...proof });
      out.push({ key: i.idempotencyKey, action: "LANDED" });
    } else if (d === "FAILED_ON_CHAIN" && st.slot !== null) {
      await store.finalize(i.idempotencyKey, "FAILED_ON_CHAIN", st.slot, { signature: i.signature, status: "FINALIZED_ERR" });
      out.push({ key: i.idempotencyKey, action: "FAILED_ON_CHAIN" });
    } else if (d === "EXPIRED_NOT_LANDED" && height !== null) {
      await store.finalize(i.idempotencyKey, "EXPIRED_NOT_LANDED", height, { signature: i.signature, finalizedBlockHeight: height, lastValidBlockHeight: i.lastValidBlockHeight, status: st.status });
      out.push({ key: i.idempotencyKey, action: "EXPIRED_NOT_LANDED" });
    } else if (sender && st.status === "NOT_FOUND" && height !== null && height <= i.lastValidBlockHeight) {
      try { await sender.send(i.signedBase64); } catch { /* still ambiguous */ }
      out.push({ key: i.idempotencyKey, action: "RESENT_SAME_BYTES" });
    } else out.push({ key: i.idempotencyKey, action: "WAIT" });
  }
  return out;
}

/** Memory ExecStore for tests (mirrors the SQL guard rules). */
export function memoryExecStore() {
  const rows = new Map<string, OpenIntent & { state: string; sent: number }>();
  const store: ExecStore & { rows: typeof rows; seed(i: OpenIntent): void; recordSigned(k: string, sig: string, b64: string): Promise<void> } = {
    rows,
    seed(i) { rows.set(i.idempotencyKey, { ...i, signature: "", signedBase64: "", state: "RESERVED", sent: 0 }); },
    async recordSigned(k, sig, b64) { const r = rows.get(k); if (!r || r.state !== "RESERVED") throw new Error("intent_not_reserved"); Object.assign(r, { state: "SIGNED", signature: sig, signedBase64: b64 }); },
    async markSent(k) { const r = rows.get(k); if (!r || r.state !== "SIGNED") throw new Error("not_signed"); r.sent++; },
    async finalize(k, o) { const r = rows.get(k); if (!r || r.state !== "SIGNED") return false; r.state = o; return true; },
    async openSigned() { return [...rows.values()].filter((r) => r.state === "SIGNED"); },
  };
  return store;
}
