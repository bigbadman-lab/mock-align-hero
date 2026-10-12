// Fee-SHARING source decoder (separate from the single-recipient decoder in pump-events.ts).
// Evidence = Pump self-CPI DistributeCreatorFeesEvent (signed by Pump's event authority) + the lamport transfers
// executed inside that same instruction from the sharing-config creator vault to each shareholder.
// Binding: mint → sharing_config PDA (Pump Fees, ["sharing-config", mint]) → creator vault PDA (Pump, ["creator-vault", sharing_config]).
// AMM → Pump sweeps (transfer_creator_fees_to_pump_v2) are movements between vaults, never receipts.
import bs58 from "bs58";
import { getProgramDerivedAddress, getAddressEncoder, address } from "@solana/addresses";
import { EVENT_AUTHORITY, PUMP_AMM_PROGRAM, PUMP_PROGRAM } from "./pump-events";

export const PUMP_FEES_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const SYSTEM = "11111111111111111111111111111111";
const DEFAULT_PUBKEY = SYSTEM;
const WSOL = "So11111111111111111111111111111111111111112";
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const DISTRIBUTE_EVENT = [165, 55, 129, 112, 4, 179, 202, 40]; // @pump-fun/pump-sdk 4.0.0 IDL

const enc = getAddressEncoder();
export async function sharingConfigPda(mint: string) {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(PUMP_FEES_PROGRAM), seeds: [new TextEncoder().encode("sharing-config"), enc.encode(address(mint))] });
  return pda as string;
}
export async function sharingCreatorVaultPda(sharingConfig: string) {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(PUMP_PROGRAM), seeds: [new TextEncoder().encode("creator-vault"), enc.encode(address(sharingConfig))] });
  return pda as string;
}

export type ShareholderReceipt = { address: string; shareBps: number; lamports: bigint };
export type Distribution = {
  signature: string; slot: number; blockTime: number | null; ixIndex: number; eventIndex: number;
  mint: string; bondingCurve: string; sharingConfig: string; creatorVault: string; admin: string; quoteMint: string;
  distributed: bigint; receipts: ShareholderReceipt[]; asset: "SOL";
};
export type AmmSweep = { signature: string; ixIndex: number; from: string; to: string; lamports: bigint };

export type SharingDecode =
  | { kind: "OK"; distributions: Distribution[]; sweeps: AmmSweep[] }
  | { kind: "SKIP"; reason: "transaction_failed" | "no_distribution" }
  | { kind: "UNKNOWN"; reason: string };

const eq = (a: Uint8Array, o: number, b: number[]) => b.every((x, i) => a[o + i] === x);
const dv = (a: Uint8Array, o: number, n: number) => new DataView(a.buffer, a.byteOffset + o, n);
const pk = (a: Uint8Array, o: number) => bs58.encode(a.subarray(o, o + 32));

type Ix = { programIdIndex: number; data: string; accounts: number[]; stackHeight?: number | null };
type RpcTx = {
  slot: number; blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: Ix[] } };
  meta: null | { err: unknown; innerInstructions?: { index: number; instructions: Ix[] }[]; loadedAddresses?: { writable: string[]; readonly: string[] } };
};

function systemTransfer(d: Uint8Array): bigint | null {
  return d.length === 12 && d[0] === 2 && d[1] === 0 && d[2] === 0 && d[3] === 0 ? dv(d, 4, 8).getBigUint64(0, true) : null;
}

export async function decodeSharing(tx: RpcTx | null): Promise<SharingDecode> {
  if (!tx) return { kind: "UNKNOWN", reason: "transaction_not_found" };
  if (!tx.meta) return { kind: "UNKNOWN", reason: "no_meta" };
  if (tx.meta.err !== null) return { kind: "SKIP", reason: "transaction_failed" };
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const distributions: Distribution[] = [], sweeps: AmmSweep[] = [];
  for (const g of tx.meta.innerInstructions ?? []) {
    const outer = tx.transaction.message.instructions[g.index];
    const outerProgram = outer ? keys[outer.programIdIndex] : undefined;
    const transfers: { from: string; to: string; lamports: bigint }[] = [];
    let ev = 0;
    for (const ix of g.instructions) {
      const program = keys[ix.programIdIndex];
      let d: Uint8Array;
      try { d = bs58.decode(ix.data); } catch { return { kind: "UNKNOWN", reason: "undecodable_inner_data" }; }
      if (program === SYSTEM) { const l = systemTransfer(d); if (l !== null) transfers.push({ from: keys[ix.accounts[0]!]!, to: keys[ix.accounts[1]!]!, lamports: l }); continue; }
      if (program !== PUMP_PROGRAM || d.length < 16 || !eq(d, 0, EVENT_IX_TAG) || !eq(d, 8, DISTRIBUTE_EVENT)) continue;
      if (ix.accounts.length !== 1 || keys[ix.accounts[0]!] !== EVENT_AUTHORITY[PUMP_PROGRAM]) return { kind: "UNKNOWN", reason: "event_authority_mismatch" };
      if (d.length < 156) return { kind: "UNKNOWN", reason: "short_event" };
      const n = dv(d, 152, 4).getUint32(0, true);
      if (n < 1 || n > 10 || d.length < 156 + n * 34 + 8) return { kind: "UNKNOWN", reason: "bad_shareholder_vec" };
      const holders = Array.from({ length: n }, (_, i) => ({ address: pk(d, 156 + i * 34), shareBps: dv(d, 156 + i * 34 + 32, 2).getUint16(0, true) }));
      const o = 156 + n * 34;
      const distributed = dv(d, o, 8).getBigUint64(0, true);
      const quoteMint = d.length >= o + 40 ? pk(d, o + 8) : DEFAULT_PUBKEY;
      const mint = pk(d, 24), sharingConfig = pk(d, 88);
      if ((await sharingConfigPda(mint)) !== sharingConfig) return { kind: "UNKNOWN", reason: "sharing_config_not_derived_from_mint" };
      const creatorVault = await sharingCreatorVaultPda(sharingConfig);
      if (quoteMint !== DEFAULT_PUBKEY && quoteMint !== WSOL) return { kind: "UNKNOWN", reason: "non_sol_quote_not_supported" };
      if (holders.reduce((s, h) => s + h.shareBps, 0) !== 10_000) return { kind: "UNKNOWN", reason: "shares_not_10000" };
      // Receipts = transfers from the derived creator vault to listed shareholders inside this same instruction.
      const fromVault = transfers.filter((t) => t.from === creatorVault);
      const receipts = holders.map((h) => ({ ...h, lamports: fromVault.filter((t) => t.to === h.address).reduce((s, t) => s + t.lamports, 0n) }));
      if (fromVault.some((t) => !holders.some((h) => h.address === t.to))) return { kind: "UNKNOWN", reason: "vault_transfer_to_non_shareholder" };
      const paid = receipts.reduce((s, r) => s + r.lamports, 0n);
      if (paid !== distributed) return { kind: "UNKNOWN", reason: "transfers_do_not_match_distributed" };
      if (outerProgram !== PUMP_PROGRAM && outerProgram !== PUMP_FEES_PROGRAM) return { kind: "UNKNOWN", reason: "unexpected_outer_program" };
      distributions.push({ signature: tx.transaction.signatures[0]!, slot: tx.slot, blockTime: tx.blockTime ?? null, ixIndex: g.index, eventIndex: ev++, mint, bondingCurve: pk(d, 56), sharingConfig, creatorVault, admin: pk(d, 120), quoteMint, distributed, receipts, asset: "SOL" });
      transfers.length = 0;
    }
    if (outerProgram === PUMP_AMM_PROGRAM) for (const t of transfers) sweeps.push({ signature: tx.transaction.signatures[0]!, ixIndex: g.index, ...t });
  }
  return distributions.length || sweeps.length ? { kind: "OK", distributions, sweeps } : { kind: "SKIP", reason: "no_distribution" };
}

/** Policy check for the future native $MCP: exactly two shareholders at 6000/4000 to the approved treasuries, SOL only. */
export function checkNativeSplit(d: Distribution, cfg: { mint: string; rewardsTreasury: string; operationsTreasury: string }) {
  const issues: string[] = [];
  if (d.mint !== cfg.mint) issues.push("wrong_mint");
  if (d.receipts.length !== 2) issues.push("shareholder_count_not_2");
  const r = d.receipts.find((x) => x.address === cfg.rewardsTreasury), o = d.receipts.find((x) => x.address === cfg.operationsTreasury);
  if (!r || r.shareBps !== 6000) issues.push("rewards_share_not_6000");
  if (!o || o.shareBps !== 4000) issues.push("operations_share_not_4000");
  return { ok: issues.length === 0, issues, rewards: r?.lamports ?? 0n, operations: o?.lamports ?? 0n };
}

/** Internal division of ACTUAL rewards-treasury lamports: floor half to SOL payouts, the rest (≥ half) to buyback, so no lamport is invented. */
export function splitRewardsReceipt(lamports: bigint) {
  if (lamports < 0n) throw new Error("negative");
  const solPayout = lamports / 2n;
  return { solPayout, buyback: lamports - solPayout, oddLamport: lamports % 2n };
}
