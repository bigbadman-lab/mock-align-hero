// Strict validator for the two operator lookup-table transactions (server + tests; no web3.js).
// Accepts only: one v0/legacy message, fee payer = signer = deployer, no lookups, exactly one instruction
// to the Address Lookup Table program — CreateLookupTable, or ExtendLookupTable with manifest addresses.
import bs58 from "bs58";
import { readCompactU16 } from "@/lib/launch/tx-wire";
import { ALT_AUTHORITY, ALT_PROGRAM_ID, STATIC_ALT_ENTRIES } from "./alt-manifest";

const SYSTEM = "11111111111111111111111111111111";
export type AltTx = { kind: "create"; table: string; recentSlot: number } | { kind: "extend"; table: string; addresses: string[] };

type Parsed = { numSigners: number; keys: string[]; ixs: { program: string; accounts: string[]; data: Uint8Array }[]; lookups: number };
export function parseMessage(m: Uint8Array): Parsed {
  let o = 0;
  const versioned = (m[0]! & 0x80) !== 0;
  if (versioned) { if ((m[0]! & 0x7f) !== 0) throw new Error("unsupported_version"); o = 1; }
  const numSigners = m[o]!; o += 3;
  let [n, l] = readCompactU16(m, o); o += l;
  const keys: string[] = [];
  for (let i = 0; i < n; i++, o += 32) keys.push(bs58.encode(m.subarray(o, o + 32)));
  o += 32; // recent blockhash
  [n, l] = readCompactU16(m, o); o += l;
  const ixs: Parsed["ixs"] = [];
  for (let i = 0; i < n; i++) {
    const p = m[o++]!;
    let [na, la] = readCompactU16(m, o); o += la;
    const accounts = [...m.subarray(o, o + na)].map((x) => keys[x]!); o += na;
    const [nd, ld] = readCompactU16(m, o); o += ld;
    ixs.push({ program: keys[p]!, accounts, data: m.slice(o, o + nd) }); o += nd;
  }
  let lookups = 0;
  if (versioned) { [lookups] = readCompactU16(m, o); }
  if (keys.some((k) => k === undefined) || o > m.length) throw new Error("bad_message");
  return { numSigners, keys, ixs, lookups };
}

const u32 = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset).getUint32(0, true);
const u64 = (d: Uint8Array, at: number) => Number(new DataView(d.buffer, d.byteOffset).getBigUint64(at, true));

export function validateAltMessage(m: Uint8Array): { ok: true; tx: AltTx } | { ok: false; code: string } {
  let p: Parsed;
  try { p = parseMessage(m); } catch { return { ok: false, code: "UNPARSEABLE" }; }
  if (p.numSigners !== 1 || p.keys[0] !== ALT_AUTHORITY) return { ok: false, code: "SIGNER_NOT_DEPLOYER" };
  if (p.lookups !== 0) return { ok: false, code: "LOOKUPS_NOT_ALLOWED" };
  if (p.ixs.length !== 1) return { ok: false, code: "ONE_INSTRUCTION_ONLY" };
  const ix = p.ixs[0]!;
  if (ix.program !== ALT_PROGRAM_ID) return { ok: false, code: "WRONG_PROGRAM" };
  const [table, authority, payer, system] = ix.accounts;
  if (ix.accounts.length !== 4 || authority !== ALT_AUTHORITY || payer !== ALT_AUTHORITY || system !== SYSTEM || !table) return { ok: false, code: "WRONG_ACCOUNTS" };
  const tag = ix.data.length >= 4 ? u32(ix.data) : -1;
  if (tag === 0 && ix.data.length === 13) return { ok: true, tx: { kind: "create", table, recentSlot: u64(ix.data, 4) } };
  if (tag === 2 && ix.data.length >= 12) {
    const n = u64(ix.data, 4);
    if (ix.data.length !== 12 + 32 * n || n < 1) return { ok: false, code: "BAD_EXTEND" };
    const addresses = Array.from({ length: n }, (_, i) => bs58.encode(ix.data.subarray(12 + 32 * i, 44 + 32 * i)));
    const allowed = new Set(STATIC_ALT_ENTRIES.map((e) => e.address));
    if (addresses.some((a) => !allowed.has(a)) || new Set(addresses).size !== n) return { ok: false, code: "ADDRESS_NOT_IN_MANIFEST" };
    return { ok: true, tx: { kind: "extend", table, addresses } };
  }
  return { ok: false, code: "INSTRUCTION_NOT_ALLOWED" };
}
