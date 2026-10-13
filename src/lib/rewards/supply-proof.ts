// Phase 05-I — historical supply at a past cutoff, proven independently of the token-balance replay.
//
// supply(cutoff) = supply(S) − Σ net supply change of every finalized tx in (cutoff, S], where supply(S) is read from
// the mint account itself at finalized context slot S, and the change of each tx is decoded from its SPL Token /
// Token-2022 INSTRUCTIONS (MintTo/MintToChecked/Burn/BurnChecked, top-level and inner). Every supply-changing
// instruction must reference the mint account, so the mint's own complete history covers them all.
// The token-balance replay (pre/postTokenBalances) is a different data path; equality of the two is the check.
// Any token instruction we cannot classify → UNKNOWN → the snapshot is held (never assumed zero).
export const TOKEN_PROGRAM_IDS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const SUPPLY_NEUTRAL = new Set([0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42, 43, 44]);
// 8-byte interface discriminators (sha256("spl_token_metadata_interface:*") / group interface) — supply neutral.
const IFACE = new Set(["d2e11ea258b84d8d", "82442a6d3412ceff", "7558f544d6ab9218", "7f5fb8473f234d51", "7c700be0442515a9", "580dd555ceb6532e", "6c25ab8ff81e126e", "a1695801edddd8cb", "9820deb0dfed7486"]);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  let n = 0n; for (const ch of s) { const v = B58.indexOf(ch); if (v < 0) throw new Error("bad_b58"); n = n * 58n + BigInt(v); }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
const u64 = (d: Uint8Array, o: number) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!); return v; };
const hex8 = (d: Uint8Array) => [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");

type RawIx = { programIdIndex: number; accounts: number[]; data: string };
export type RawTx = { slot: number; transaction: { message: { accountKeys: string[]; instructions: RawIx[] } };
  meta: { err: unknown; innerInstructions?: { instructions: RawIx[] }[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } } };

/** Net change in `mint` supply caused by one finalized tx. Failed txs change nothing. */
export function supplyDelta(tx: RawTx, mint: string): bigint | { unknown: string } {
  if (tx.meta.err !== null) return 0n;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
  let delta = 0n;
  for (const ix of all) {
    if (!TOKEN_PROGRAM_IDS.has(keys[ix.programIdIndex]!)) continue;
    const d = b58decode(ix.data); const tag = d[0];
    if (tag === undefined) return { unknown: "empty_token_ix" };
    if (d.length >= 8 && IFACE.has(hex8(d))) continue;
    if (tag === 7 || tag === 14) { if (keys[ix.accounts[0]!] === mint) delta += u64(d, 1); continue; }   // MintTo[Checked]: [mint, dest, auth]
    if (tag === 8 || tag === 15) { if (keys[ix.accounts[1]!] === mint) delta -= u64(d, 1); continue; }   // Burn[Checked]: [acct, mint, owner]
    if (SUPPLY_NEUTRAL.has(tag)) continue;
    return { unknown: `token_ix_${tag}` }; // e.g. 39 ConfidentialMintBurn — cannot be valued here
  }
  return delta;
}

export type SupplyProof =
  | { kind: "PROVEN"; cutoffSlot: number; supplyAtCutoff: bigint; anchorSlot: number; anchorSupply: bigint; laterTxs: number; laterNetChange: bigint; method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" }
  | { kind: "UNPROVEN"; reason: string };

/** `later` must be the mint's COMPLETE finalized history in (cutoffSlot, anchorSlot] (caller attests pagination exhaustion). */
export function supplyAtCutoff(cutoffSlot: number, anchor: { slot: number; supply: bigint } | null, later: RawTx[], mint: string, historyComplete: boolean): SupplyProof {
  if (!anchor) return { kind: "UNPROVEN", reason: "ANCHOR_SUPPLY_UNKNOWN" };
  if (!historyComplete) return { kind: "UNPROVEN", reason: "MINT_HISTORY_INCOMPLETE" };
  if (anchor.slot < cutoffSlot) return { kind: "UNPROVEN", reason: "ANCHOR_BEFORE_CUTOFF" };
  let net = 0n, n = 0;
  for (const t of later) {
    if (t.slot <= cutoffSlot || t.slot > anchor.slot) return { kind: "UNPROVEN", reason: "TX_OUTSIDE_RANGE" };
    const d = supplyDelta(t, mint); if (typeof d !== "bigint") return { kind: "UNPROVEN", reason: d.unknown };
    net += d; n++;
  }
  const s = anchor.supply - net;
  if (s < 0n) return { kind: "UNPROVEN", reason: "NEGATIVE_SUPPLY" };
  return { kind: "PROVEN", cutoffSlot, supplyAtCutoff: s, anchorSlot: anchor.slot, anchorSupply: anchor.supply, laterTxs: n, laterNetChange: net, method: "MINT_ACCOUNT_AT_S_MINUS_IX_DELTAS_V1" };
}
