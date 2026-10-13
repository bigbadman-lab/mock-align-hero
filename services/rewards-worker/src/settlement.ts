// REWARDS-EXEC-01C C01/C02 — deterministic finalized-transaction verifier. Pure: input is a getTransaction
// (commitment finalized, encoding "json", maxSupportedTransactionVersion 0) result + the persisted intent.
// Only metadata balances are trusted (never logs, confirmation status or explorer links).
// Output: PROVEN (exact per-recipient deltas, fee, rent) | MISMATCH (reason) | UNKNOWN (evidence unavailable).
import { createHash } from "node:crypto";
import bs58 from "bs58";

export type FinalTx = {
  slot: number;
  transaction: { signatures: string[]; message: { accountKeys?: string[]; staticAccountKeys?: string[]; serialized?: string } };
  meta: {
    err: unknown; fee: number; preBalances: number[]; postBalances: number[];
    preTokenBalances?: TB[] | null; postTokenBalances?: TB[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
} | null;
type TB = { accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string } };

export type Expected = {
  kind: "SOL_PAYOUT" | "TOKEN_PAYOUT";
  signature: string; deployer: string;
  /** sha256 hex of the persisted serialized message; checked when the RPC result carries the raw message. */
  messageSha256: string; messageBase64?: string | null;
  rows: readonly { owner: string; amount: bigint }[];
  mint?: string; tokenProgram?: string;
};
export type Proof =
  | { kind: "PROVEN"; slot: number; signature: string; delivered: { owner: string; amount: string }[]; feeLamports: string; rentLamports: string; deployerDebit: string }
  | { kind: "MISMATCH"; reason: string }
  | { kind: "UNKNOWN"; reason: string };

const SYSTEM_LIKE = new Set(["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111"]);

const keysOf = (t: NonNullable<FinalTx>) => [
  ...(t.transaction.message.staticAccountKeys ?? t.transaction.message.accountKeys ?? []),
  ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? []),
];

export function verifySettlement(t: FinalTx, e: Expected): Proof {
  if (!t) return { kind: "UNKNOWN", reason: "TX_NOT_FOUND_AT_FINALIZED" };
  if (!t.meta) return { kind: "UNKNOWN", reason: "META_MISSING" };
  if (t.transaction.signatures[0] !== e.signature) return { kind: "MISMATCH", reason: "SIGNATURE_MISMATCH" };
  if (e.messageBase64) {
    const h = createHash("sha256").update(Buffer.from(e.messageBase64, "base64")).digest("hex");
    if (h !== e.messageSha256) return { kind: "MISMATCH", reason: "PERSISTED_MESSAGE_HASH_MISMATCH" };
  }
  if (t.meta.err !== null) return { kind: "MISMATCH", reason: "TX_FAILED_ON_CHAIN" };
  const keys = keysOf(t);
  if (keys[0] !== e.deployer) return { kind: "MISMATCH", reason: "FEE_PAYER_NOT_DEPLOYER" };
  const { preBalances: pre, postBalances: post } = t.meta;
  if (pre.length !== keys.length || post.length !== keys.length) return { kind: "UNKNOWN", reason: "BALANCE_ARRAYS_MALFORMED" };
  const expect = new Map<string, bigint>();
  for (const r of e.rows) { if (expect.has(r.owner) || r.amount <= 0n) return { kind: "MISMATCH", reason: "PLAN_ROWS_INVALID" }; expect.set(r.owner, r.amount); }
  const fee = BigInt(t.meta.fee);
  const deployerDebit = BigInt(pre[0]!) - BigInt(post[0]!);
  const delivered: { owner: string; amount: string }[] = [];

  if (e.kind === "SOL_PAYOUT") {
    let paid = 0n;
    for (let i = 1; i < keys.length; i++) {
      const d = BigInt(post[i]!) - BigInt(pre[i]!); const k = keys[i]!;
      if (d === 0n) continue;
      const want = expect.get(k);
      if (want === undefined) return { kind: "MISMATCH", reason: `UNEXPECTED_SOL_MOVEMENT:${k}` };
      if (d !== want) return { kind: "MISMATCH", reason: `AMOUNT_MISMATCH:${k}` };
      delivered.push({ owner: k, amount: d.toString() }); paid += d;
    }
    if (delivered.length !== expect.size) return { kind: "MISMATCH", reason: "INCOMPLETE_BATCH" };
    if (deployerDebit !== paid + fee) return { kind: "MISMATCH", reason: "DEPLOYER_DEBIT_MISMATCH" };
    return { kind: "PROVEN", slot: t.slot, signature: e.signature, delivered, feeLamports: fee.toString(), rentLamports: "0", deployerDebit: deployerDebit.toString() };
  }

  // TOKEN_PAYOUT: deltas per (owner, mint) from token balances; ATA funding is rent, never a reward.
  if (!e.mint || !e.tokenProgram) return { kind: "MISMATCH", reason: "MINT_OR_PROGRAM_UNSET" };
  const preT = t.meta.preTokenBalances, postT = t.meta.postTokenBalances;
  if (!preT || !postT) return { kind: "UNKNOWN", reason: "TOKEN_BALANCES_MISSING" };
  const bal = new Map<number, { owner: string; mint: string; prog?: string; pre: bigint; post: bigint }>();
  for (const [arr, side] of [[preT, "pre"], [postT, "post"]] as const) for (const b of arr) {
    if (!b.owner) return { kind: "UNKNOWN", reason: "TOKEN_OWNER_MISSING" };
    const cur = bal.get(b.accountIndex) ?? { owner: b.owner, mint: b.mint, prog: b.programId, pre: 0n, post: 0n };
    if (cur.owner !== b.owner || cur.mint !== b.mint) return { kind: "MISMATCH", reason: "TOKEN_ACCOUNT_IDENTITY_CHANGED" };
    cur[side] = BigInt(b.uiTokenAmount.amount); bal.set(b.accountIndex, cur);
  }
  let paid = 0n, deployerTok = 0n; const got = new Map<string, bigint>();
  for (const [, b] of bal) {
    const d = b.post - b.pre; if (d === 0n) continue;
    if (b.mint !== e.mint) return { kind: "MISMATCH", reason: "WRONG_MINT_MOVED" };
    if (b.prog && b.prog !== e.tokenProgram) return { kind: "MISMATCH", reason: "WRONG_TOKEN_PROGRAM" };
    if (b.owner === e.deployer) { deployerTok += d; continue; }
    const want = expect.get(b.owner);
    if (want === undefined) return { kind: "MISMATCH", reason: `UNEXPECTED_TOKEN_MOVEMENT:${b.owner}` };
    got.set(b.owner, (got.get(b.owner) ?? 0n) + d);
  }
  for (const [o, want] of expect) { const g = got.get(o); if (g === undefined) return { kind: "MISMATCH", reason: "INCOMPLETE_BATCH" }; if (g !== want) return { kind: "MISMATCH", reason: `AMOUNT_MISMATCH:${o}` }; delivered.push({ owner: o, amount: g.toString() }); paid += g; }
  if (-deployerTok !== paid) return { kind: "MISMATCH", reason: "DEPLOYER_TOKEN_DEBIT_MISMATCH" };
  // SOL side: only new token accounts may gain lamports (rent); anything else is a third-party movement.
  const tokenIdx = new Set([...bal.keys()]); let rent = 0n;
  for (let i = 1; i < keys.length; i++) {
    const d = BigInt(post[i]!) - BigInt(pre[i]!); if (d === 0n) continue;
    if (!(tokenIdx.has(i) && BigInt(pre[i]!) === 0n && d > 0n) || SYSTEM_LIKE.has(keys[i]!)) return { kind: "MISMATCH", reason: `UNEXPECTED_SOL_MOVEMENT:${keys[i]}` };
    rent += d;
  }
  if (deployerDebit !== fee + rent) return { kind: "MISMATCH", reason: "DEPLOYER_DEBIT_MISMATCH" };
  return { kind: "PROVEN", slot: t.slot, signature: e.signature, delivered, feeLamports: fee.toString(), rentLamports: rent.toString(), deployerDebit: deployerDebit.toString() };
}

export type FillExpected = { signature: string; deployer: string; mint: string; maxSolLamports: bigint; minOutTokens: bigint; venues: readonly string[] };
export type Fill = { kind: "FILL"; slot: number; signature: string; tokensReceived: string; solSpent: string; feeLamports: string; rentLamports: string; venue: string }
  | { kind: "MISMATCH"; reason: string } | { kind: "UNKNOWN"; reason: string };

/** Buyback fill = net finalized token-balance increase of the DEPLOYER's account for the verified mint.
 *  Pre-existing tokens are never counted (delta only). Quotes/simulations are never fills. */
export function verifyFill(t: FinalTx, e: FillExpected, programIds: readonly string[]): Fill {
  if (!t) return { kind: "UNKNOWN", reason: "TX_NOT_FOUND_AT_FINALIZED" };
  if (!t.meta) return { kind: "UNKNOWN", reason: "META_MISSING" };
  if (t.transaction.signatures[0] !== e.signature) return { kind: "MISMATCH", reason: "SIGNATURE_MISMATCH" };
  if (t.meta.err !== null) return { kind: "MISMATCH", reason: "SWAP_FAILED_ON_CHAIN" };
  const keys = keysOf(t);
  if (keys[0] !== e.deployer) return { kind: "MISMATCH", reason: "FEE_PAYER_NOT_DEPLOYER" };
  const venue = programIds.find((p) => e.venues.includes(p));
  if (!venue) return { kind: "MISMATCH", reason: "SWAP_PROGRAM_NOT_ALLOWED" };
  const preT = t.meta.preTokenBalances, postT = t.meta.postTokenBalances;
  if (!preT || !postT) return { kind: "UNKNOWN", reason: "TOKEN_BALANCES_MISSING" };
  const mine = (arr: TB[]) => arr.filter((b) => b.owner === e.deployer && b.mint === e.mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const got = mine(postT) - mine(preT);
  if (got <= 0n) return { kind: "MISMATCH", reason: "NO_TOKENS_RECEIVED" };
  if (got < e.minOutTokens) return { kind: "MISMATCH", reason: "BELOW_MIN_OUT" };
  const fee = BigInt(t.meta.fee);
  const debit = BigInt(t.meta.preBalances[0]!) - BigInt(t.meta.postBalances[0]!);
  // new ATA for the deployer (first buy) is rent, not swap spend
  const newAta = postT.find((b) => b.owner === e.deployer && b.mint === e.mint && !preT.some((p) => p.accountIndex === b.accountIndex));
  const rent = newAta ? BigInt(t.meta.postBalances[newAta.accountIndex]!) - BigInt(t.meta.preBalances[newAta.accountIndex]!) : 0n;
  const spent = debit - fee - rent;
  if (spent <= 0n) return { kind: "MISMATCH", reason: "NO_SOL_SPENT" };
  if (spent > e.maxSolLamports) return { kind: "MISMATCH", reason: "SOL_SPENT_ABOVE_BUDGET" };
  return { kind: "FILL", slot: t.slot, signature: e.signature, tokensReceived: got.toString(), solSpent: spent.toString(), feeLamports: fee.toString(), rentLamports: rent.toString(), venue };
}

export const sha256hexOfMessage = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
void bs58;
