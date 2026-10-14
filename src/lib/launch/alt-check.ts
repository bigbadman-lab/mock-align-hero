// Lookup-table check at signing time (browser + workerd safe). The transaction must be a v0 message whose
// only lookup is the configured production ALT; that ALT must be active (never deactivated) and long enough
// for every index used; and the signed transaction must fit Solana's 1,232-byte limit. Fails closed.
import bs58 from "bs58";
import { readCompactU16 } from "./tx-wire";

export const TX_LIMIT = 1232;
const ALT_HEADER = 56;
const U64_MAX = 0xffffffffffffffffn;

export type Lookup = { table: string; writable: number[]; readonly: number[] };

export function parseV0Lookups(msg: Uint8Array): Lookup[] {
  if ((msg[0]! & 0x80) === 0 || (msg[0]! & 0x7f) !== 0) throw new Error("not_v0");
  let o = 4;
  const rd = () => { const [v, l] = readCompactU16(msg, o); o += l; return v; };
  const nKeys = rd(); o += nKeys * 32 + 32;
  const nIx = rd();
  for (let i = 0; i < nIx; i++) { o += 1; const a = rd(); o += a; const d = rd(); o += d; }
  const nL = rd(), out: Lookup[] = [];
  for (let i = 0; i < nL; i++) {
    if (o + 32 > msg.length) throw new Error("bad_message");
    const table = bs58.encode(msg.subarray(o, o + 32)); o += 32;
    const nw = rd(); const writable = [...msg.subarray(o, o + nw)]; o += nw;
    const nr = rd(); const readonly = [...msg.subarray(o, o + nr)]; o += nr;
    out.push({ table, writable, readonly });
  }
  if (o !== msg.length) throw new Error("bad_message");
  return out;
}

export function parseAlt(data: Uint8Array): { active: boolean; addresses: number } {
  if (data.length < ALT_HEADER || (data.length - ALT_HEADER) % 32 !== 0) throw new Error("bad_alt");
  const type = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
  if (type !== 1) throw new Error("bad_alt");
  const deact = new DataView(data.buffer, data.byteOffset).getBigUint64(4, true);
  return { active: deact === U64_MAX, addresses: (data.length - ALT_HEADER) / 32 };
}

/** null = OK; otherwise a fail-closed code. altOwner must be the address-lookup-table program. */
export function checkAltUse(msg: Uint8Array, signers: number, expected: string | null, alt: { owner: string; data: Uint8Array } | null): string | null {
  if (!expected) return "ALT_NOT_CONFIGURED";
  const size = (signers < 0x80 ? 1 : 2) + 64 * signers + msg.length;
  if (size > TX_LIMIT) return "TX_TOO_LARGE";
  let lookups: Lookup[];
  try { lookups = parseV0Lookups(msg); } catch { return "TX_NOT_V0"; }
  if (lookups.length !== 1 || lookups[0]!.table !== expected) return "ALT_NOT_USED";
  if (!alt) return "ALT_UNAVAILABLE";
  if (alt.owner !== "AddressLookupTab1e1111111111111111111111111") return "ALT_WRONG_OWNER";
  let a;
  try { a = parseAlt(alt.data); } catch { return "ALT_UNREADABLE"; }
  if (!a.active) return "ALT_DEACTIVATED";
  const max = Math.max(-1, ...lookups[0]!.writable, ...lookups[0]!.readonly);
  if (max >= a.addresses) return "ALT_INSUFFICIENT";
  return null;
}
