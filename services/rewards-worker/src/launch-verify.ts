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

// ---- SOL MAINNET REHEARSAL (one-time; migration 0027). Separate path: never uses or alters the $MCP checks above.
export const NATIVE_SOL = "So11111111111111111111111111111111111111112";
export const NATIVE_SOL_DEFAULT = "11111111111111111111111111111111";
export type RehearsalPermission = { creator: string; status: string; mint: string | null; signature: string | null };

/** The pending claim that IS the rehearsal (exact creator + mint + signature of the SUBMITTED permission), if any. */
export function rehearsalClaimOf(p: RehearsalPermission | null, claims: Claim[]): Claim | null {
  if (!p || p.status !== "SUBMITTED" || !p.mint || !p.signature) return null;
  return claims.find((c) => c.mint === p.mint && c.signature === p.signature && c.creator === p.creator) ?? null;
}

/** Same signer/program checks as verifyLaunch, then: curve quote = native SOL, sharing config locked at
 *  60% permitted creator / 25% env ops / 15% env platform. Unrelated SOL tokens never reach here. */
export function verifyRehearsalLaunch(c: Claim, p: RehearsalPermission, tx: LaunchTx, o: OnchainChild | null, a: Authorized, sharingConfig: string): LaunchVerdict {
  if (c.creator !== p.creator || c.mint !== p.mint || c.signature !== p.signature) return { ok: false, code: "NOT_THE_REHEARSAL", final: false };
  if (!a.ops || !a.platform || !a.nativeDeployer) return { ok: false, code: "AUTHORIZED_RECIPIENTS_UNSET", final: false };
  if (!tx.found) return { ok: false, code: "TX_NOT_FOUND", final: false };
  if (!tx.finalized) return { ok: false, code: "TX_NOT_FINALIZED", final: false };
  if (tx.err !== null && tx.err !== undefined) return { ok: false, code: "TX_FAILED", final: true };
  if (tx.accountKeys[0] !== c.creator) return { ok: false, code: "FEE_PAYER_NOT_CREATOR", final: true };
  if (!tx.accountKeys.slice(0, tx.numSigners).includes(c.mint)) return { ok: false, code: "MINT_NOT_CREATED_IN_TX", final: true };
  if ([a.nativeDeployer, a.ops, a.platform].includes(c.creator)) return { ok: false, code: "CREATOR_PROHIBITED", final: true };
  if (!tx.programIds.includes(PUMP_PROGRAM)) return { ok: false, code: "NOT_A_PUMP_LAUNCH", final: true };
  if (!o) return { ok: false, code: "EVIDENCE_UNAVAILABLE", final: false };
  const sc = o.sharingConfig;
  if (!sc) return { ok: false, code: "SHARING_CONFIG_MISSING", final: false };
  if (sc.mint !== c.mint) return { ok: false, code: "SHARING_CONFIG_MINT_MISMATCH", final: true };
  if (!sc.adminRevoked) return { ok: false, code: "SHARES_NOT_LOCKED", final: true };
  if (o.curveCreator !== sharingConfig) return { ok: false, code: "CURVE_CREATOR_NOT_SHARING_CONFIG", final: true };
  // Pump stores native-SOL curves with the default (all-zero) pubkey as quote mint; wSOL is accepted too.
  if (o.curveQuoteMint !== NATIVE_SOL && o.curveQuoteMint !== NATIVE_SOL_DEFAULT) return { ok: false, code: "QUOTE_NOT_NATIVE_SOL", final: true };
  if (o.graduated === null) return { ok: false, code: "GRADUATION_UNKNOWN", final: false };
  const rec: ChildRecord = { mint: c.mint, creator: c.creator, ops: a.ops, platform: a.platform, quoteMint: NATIVE_SOL, quoteTokenProgram: "", sharingConfig };
  const r = verifyRecipients(rec, o, p.creator, a);
  if (!r.ok) return { ok: false, code: r.code, final: true };
  return { ok: true, slot: tx.slot, evidenceId: `rehearsal:${c.signature.slice(0, 64)}` };
}

export type RehearsalDeps = Pick<LaunchDeps, "pending" | "readTx" | "readChild" | "sharingConfigOf" | "reject"> & {
  permission(): Promise<RehearsalPermission | null>;
  registerRehearsal(id: string, slot: number, evidenceId: string): Promise<string>;
};

/** Runs even before the $MCP mint exists. Read-only chain access; the only write is the single atomic SQL call. */
export async function runRehearsalVerifier(d: RehearsalDeps, a: Authorized): Promise<LaunchOutcome[]> {
  let p: RehearsalPermission | null, claims: Claim[];
  try { [p, claims] = await Promise.all([d.permission(), d.pending()]); } catch { return [{ claim: "rehearsal", result: "HELD:REHEARSAL_UNAVAILABLE" }]; }
  const c = rehearsalClaimOf(p, claims);
  if (!c || !p) return [];
  let v: LaunchVerdict;
  try {
    const tx = await d.readTx(c.signature);
    const oc = tx.found && tx.finalized && !tx.err ? await d.readChild(c) : null;
    v = verifyRehearsalLaunch(c, p, tx, oc, a, d.sharingConfigOf(c.mint));
  } catch { v = { ok: false, code: "EVIDENCE_UNAVAILABLE", final: false }; }
  // A rejected rehearsal claim leaves the permission SUBMITTED: no new launch is possible; operator revokes.
  if (!v.ok) {
    if (v.final) { await d.reject(c.id, `REHEARSAL_${v.code}`.slice(0, 64)).catch(() => {}); return [{ claim: c.id, result: `REJECTED:${v.code}` }]; }
    return [{ claim: c.id, result: `HELD:${v.code}` }];
  }
  try { return [{ claim: c.id, result: await d.registerRehearsal(c.id, v.slot, v.evidenceId) }]; }
  catch (e) { return [{ claim: c.id, result: `HELD:REGISTER_FAILED:${e instanceof Error ? e.message.slice(0, 60) : "error"}` }]; }
}

export function rehearsalStorePg(db: Db) {
  return {
    async permission(): Promise<RehearsalPermission | null> {
      const r = await db.query("select creator_wallet, status, mint, signature from public.mcpx_cf_rehearsal_permission()");
      const x: any = r.rows[0];
      return x ? { creator: x.creator_wallet, status: x.status, mint: x.mint, signature: x.signature } : null;
    },
    async registerRehearsal(id: string, slot: number, ev: string) {
      const r = await db.query("select public.mcpx_cf_register_rehearsal($1::uuid, $2::bigint, $3) v", [id, slot, ev]);
      return String(r.rows[0]?.v);
    },
  };
}
