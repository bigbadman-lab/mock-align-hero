// CANVAS-01 final — post-launch product verifier (Rewards Worker #3, read-only chain access).
// A creator's claim (draft revision + mint + signature) is only a request. Registration happens only after
// this module independently proves, at FINALIZED commitment: the transaction succeeded, the claimed creator
// paid and signed it, the mint signed it (fresh mint), the Pump program ran, the curve's quote is $MCP,
// and the locked sharing config is exactly 60% creator / 25% ops / 15% platform with admin revoked.
// Registration itself (registry row + outbox + config + exact Canvas revision) is one SQL transaction.
import type { Db } from "../../../src/lib/rewards/store.pg";
import type { RpcCall } from "./pipeline";
import { verifyChild, verifyRecipients, TOKEN_2022, type ChildRecord, type OnchainChild } from "./child-fees";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MAX_CLAIMS_PER_PASS = 10;

export type Claim = { id: string; draftId: string; draftRevision: number; creator: string; mint: string; signature: string };
export type LaunchTx = { found: false } | {
  found: true; finalized: boolean; err: unknown; slot: number;
  accountKeys: string[]; numSigners: number; programIds: string[];
};
export type Authorized = { ops: string | null; platform: string | null; nativeDeployer: string | null };
export type LaunchVerdict = { ok: true; slot: number; evidenceId: string } | { ok: false; code: string; final: boolean };

/** Pure decision. `final: false` = evidence unavailable / not finalized yet → retry later, never reject. */
export function verifyLaunch(c: Claim, tx: LaunchTx, onchain: OnchainChild | null, quote: string | null, quoteProgram: string | null, a: Authorized, sharingConfig: string): LaunchVerdict {
  if (!quote) return { ok: false, code: "QUOTE_MINT_UNSET", final: false };
  if (!a.ops || !a.platform || !a.nativeDeployer) return { ok: false, code: "AUTHORIZED_RECIPIENTS_UNSET", final: false };
  if (!tx.found) return { ok: false, code: "TX_NOT_FOUND", final: false };
  if (!tx.finalized) return { ok: false, code: "TX_NOT_FINALIZED", final: false };
  if (tx.err !== null && tx.err !== undefined) return { ok: false, code: "TX_FAILED", final: true };
  const signers = tx.accountKeys.slice(0, tx.numSigners);
  if (tx.accountKeys[0] !== c.creator) return { ok: false, code: "FEE_PAYER_NOT_CREATOR", final: true };
  if (!signers.includes(c.mint)) return { ok: false, code: "MINT_NOT_CREATED_IN_TX", final: true };
  if (c.creator === a.nativeDeployer) return { ok: false, code: "CREATOR_IS_NATIVE_DEPLOYER", final: true };
  if (!tx.programIds.includes(PUMP_PROGRAM)) return { ok: false, code: "NOT_A_PUMP_LAUNCH", final: true };
  if (!onchain) return { ok: false, code: "EVIDENCE_UNAVAILABLE", final: false };
  const rec: ChildRecord = { mint: c.mint, creator: c.creator, ops: a.ops, platform: a.platform, quoteMint: quote, quoteTokenProgram: quoteProgram ?? "", sharingConfig };
  if (rec.quoteTokenProgram !== TOKEN_2022) return { ok: false, code: "QUOTE_TOKEN_PROGRAM_MISMATCH", final: false };
  let v = verifyChild(rec, onchain, quote);
  if (v.ok) v = verifyRecipients(rec, onchain, c.creator, a);
  if (!v.ok) return { ok: false, code: v.code, final: v.code !== "GRADUATION_UNKNOWN" };
  return { ok: true, slot: tx.slot, evidenceId: `launch:${c.signature.slice(0, 64)}` };
}

/** Finalized transaction read; account keys include v0 lookup-table addresses. */
export async function readLaunchTx(call: RpcCall, signature: string): Promise<LaunchTx> {
  const t = (await call("getTransaction", [signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }])) as any;
  if (!t) return { found: false };
  const m = t.transaction?.message;
  const keys: string[] = [...(m?.accountKeys ?? []), ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])];
  const programIds = [...new Set<string>((m?.instructions ?? []).map((ix: any) => keys[ix.programIdIndex]).filter(Boolean))];
  return { found: true, finalized: true, err: t.meta?.err ?? null, slot: t.slot, accountKeys: keys, numSigners: m?.header?.numRequiredSignatures ?? 0, programIds };
}

export type LaunchDeps = {
  pending(): Promise<Claim[]>;
  readTx(sig: string): Promise<LaunchTx>;
  readChild(c: Claim): Promise<OnchainChild | null>;
  quoteProgram(): Promise<string | null>;
  sharingConfigOf(mint: string): string;
  register(id: string, slot: number, quote: string, evidenceId: string): Promise<string>;
  reject(id: string, code: string): Promise<string>;
};
export type LaunchOutcome = { claim: string; result: string };

export async function runLaunchVerifier(d: LaunchDeps, quote: string | null, a: Authorized): Promise<LaunchOutcome[]> {
  const out: LaunchOutcome[] = [];
  let claims: Claim[];
  try { claims = (await d.pending()).slice(0, MAX_CLAIMS_PER_PASS); } catch { return [{ claim: "*", result: "HELD:CLAIMS_UNAVAILABLE" }]; }
  const qp = quote ? await d.quoteProgram().catch(() => null) : null;
  for (const c of claims) {
    let v: LaunchVerdict;
    try {
      const tx = await d.readTx(c.signature);
      const oc = tx.found && tx.finalized && !tx.err ? await d.readChild(c) : null;
      v = verifyLaunch(c, tx, oc, quote, qp, a, d.sharingConfigOf(c.mint));
    } catch { v = { ok: false, code: "EVIDENCE_UNAVAILABLE", final: false }; }
    if (!v.ok) {
      if (v.final) { await d.reject(c.id, v.code).catch(() => {}); out.push({ claim: c.id, result: `REJECTED:${v.code}` }); }
      else out.push({ claim: c.id, result: `HELD:${v.code}` });
      continue;
    }
    try { out.push({ claim: c.id, result: await d.register(c.id, v.slot, quote!, v.evidenceId) }); }
    catch (e) { out.push({ claim: c.id, result: `HELD:REGISTER_FAILED:${e instanceof Error ? e.message.slice(0, 60) : "error"}` }); }
  }
  return out;
}

/** Bridge-backed store (public.mcpx_cf_* only, so the site guard allows it). */
export function launchStorePg(db: Db) {
  return {
    async pending(): Promise<Claim[]> {
      const r = await db.query("select id, draft_id, draft_revision, creator_wallet, mint, signature from public.mcpx_cf_launch_claims where status = 'PENDING' order by created_at limit 10");
      return r.rows.map((x: any) => ({ id: x.id, draftId: x.draft_id, draftRevision: Number(x.draft_revision), creator: x.creator_wallet, mint: x.mint, signature: x.signature }));
    },
    async register(id: string, slot: number, quote: string, ev: string) {
      const r = await db.query("select public.mcpx_cf_register_launch($1::uuid, $2::bigint, $3, $4) v", [id, slot, quote, ev]);
      return String(r.rows[0]?.v);
    },
    async reject(id: string, code: string) {
      const r = await db.query("select public.mcpx_cf_reject_launch($1::uuid, $2) v", [id, code]);
      return String(r.rows[0]?.v);
    },
  };
}
