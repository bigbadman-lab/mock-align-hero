// Decode Pump / PumpSwap creator-fee collection events from a FINALIZED getTransaction(json) result.
// Source of truth = Anchor self-CPI events (emit_cpi) in inner instructions, executed by the program itself
// with its event_authority PDA. Log text is never trusted. Balance deltas are reconciled, never credited.
import bs58 from "bs58";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
// Anchor emit_cpi event authorities (PDA [b"__event_authority"]); observed on chain in finalized collections.
// Only the program itself can sign as this PDA, so an event ix without it is a forgery and is refused.
export const EVENT_AUTHORITY: Record<string, string> = {
  [PUMP_PROGRAM]: "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
  [PUMP_AMM_PROGRAM]: "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",
};

// Discriminators from @pump-fun/pump-sdk 4.0.0 bundled IDLs.
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const COLLECT_CREATOR_FEE_EVENT = [122, 2, 127, 1, 14, 191, 12, 175]; // Pump: timestamp i64, creator, creator_fee u64, quote_mint
const COLLECT_COIN_CREATOR_FEE_EVENT = [232, 245, 194, 238, 234, 218, 58, 89]; // AMM: timestamp, coin_creator, coin_creator_fee, vault_ata, token_account

export type FeeEvidence = {
  signature: string; slot: number; blockTime: number | null;
  source: "PUMP_CURVE_COLLECT" | "PUMP_AMM_COLLECT_COIN_CREATOR";
  ixIndex: number; eventIndex: number; programId: string;
  recipient: string; asset: "SOL" | "WSOL" | string; amount: bigint; eventTimestamp: number;
  extra: Record<string, string>;
};

export type DecodeResult =
  | { kind: "OK"; events: FeeEvidence[] }
  | { kind: "SKIP"; reason: "transaction_failed" | "no_meta" | "no_fee_events" }
  | { kind: "UNKNOWN"; reason: string };

const eq = (a: Uint8Array, off: number, b: number[]) => b.every((x, i) => a[off + i] === x);
const u64 = (a: Uint8Array, o: number) => new DataView(a.buffer, a.byteOffset + o, 8).getBigUint64(0, true);
const i64 = (a: Uint8Array, o: number) => Number(new DataView(a.buffer, a.byteOffset + o, 8).getBigInt64(0, true));
const pk = (a: Uint8Array, o: number) => bs58.encode(a.subarray(o, o + 32));

type RpcTx = {
  slot: number; blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: null | { err: unknown; innerInstructions?: { index: number; instructions: { programIdIndex: number; data: string; accounts: number[] }[] }[]; loadedAddresses?: { writable: string[]; readonly: string[] } };
};

export function decodeFeeEvents(tx: RpcTx | null): DecodeResult {
  if (!tx) return { kind: "UNKNOWN", reason: "transaction_not_found" }; // missing ≠ no fees
  if (!tx.meta) return { kind: "SKIP", reason: "no_meta" };
  if (tx.meta.err !== null) return { kind: "SKIP", reason: "transaction_failed" };
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const out: FeeEvidence[] = [];
  for (const group of tx.meta.innerInstructions ?? []) {
    let ev = 0;
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex];
      if (program !== PUMP_PROGRAM && program !== PUMP_AMM_PROGRAM) continue;
      let d: Uint8Array;
      try { d = bs58.decode(ix.data); } catch { return { kind: "UNKNOWN", reason: "undecodable_inner_data" }; }
      if (d.length < 16 || !eq(d, 0, EVENT_IX_TAG)) continue;
      if (ix.accounts.length !== 1 || keys[ix.accounts[0]!] !== EVENT_AUTHORITY[program]) return { kind: "UNKNOWN", reason: "event_authority_mismatch" };
      const base = { signature: tx.transaction.signatures[0]!, slot: tx.slot, blockTime: tx.blockTime ?? null, ixIndex: group.index, programId: program };
      if (program === PUMP_PROGRAM && eq(d, 8, COLLECT_CREATOR_FEE_EVENT)) {
        if (d.length < 16 + 8 + 32 + 8) return { kind: "UNKNOWN", reason: "short_event" };
        const quote = d.length >= 16 + 80 ? pk(d, 64) : DEFAULT_PUBKEY; // pre-v2 events had no quote_mint
        out.push({ ...base, eventIndex: ev++, source: "PUMP_CURVE_COLLECT", recipient: pk(d, 24), amount: u64(d, 56), eventTimestamp: i64(d, 16),
          asset: quote === DEFAULT_PUBKEY || quote === WSOL_MINT ? "SOL" : quote, extra: { quoteMint: quote } });
      } else if (program === PUMP_AMM_PROGRAM && eq(d, 8, COLLECT_COIN_CREATOR_FEE_EVENT)) {
        if (d.length < 16 + 8 + 32 + 8 + 64) return { kind: "UNKNOWN", reason: "short_event" };
        out.push({ ...base, eventIndex: ev++, source: "PUMP_AMM_COLLECT_COIN_CREATOR", recipient: pk(d, 24), amount: u64(d, 56), eventTimestamp: i64(d, 16),
          asset: "WSOL", extra: { vaultAta: pk(d, 64), destinationTokenAccount: pk(d, 96) } });
      }
    }
  }
  return out.length ? { kind: "OK", events: out } : { kind: "SKIP", reason: "no_fee_events" };
}
