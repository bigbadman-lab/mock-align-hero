// Minimal Solana wire-format helpers (browser + workerd safe, no web3.js). Used to place the in-browser
// mint signature, check the wallet didn't alter the message, and verify both signatures on the server.
import bs58 from "bs58";

export function readCompactU16(b: Uint8Array, o: number): [number, number] {
  let v = 0, s = 0, i = 0;
  for (;;) {
    const x = b[o + i];
    if (x === undefined || i > 2) throw new Error("bad_compact_u16");
    v |= (x & 0x7f) << s; i++;
    if (!(x & 0x80)) break;
    s += 7;
  }
  return [v, i];
}
export function writeCompactU16(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) { let x = v & 0x7f; v >>= 7; if (v) x |= 0x80; out.push(x); if (!v) break; }
  return Uint8Array.from(out);
}

/** Required signer public keys (base58), in signature order. */
export function messageSigners(msg: Uint8Array): string[] {
  let o = 0;
  if ((msg[0]! & 0x80) !== 0) { if ((msg[0]! & 0x7f) !== 0) throw new Error("unsupported_version"); o = 1; }
  const nSig = msg[o]!; o += 3;
  const [nKeys, l] = readCompactU16(msg, o); o += l;
  if (nSig > nKeys || o + nKeys * 32 > msg.length) throw new Error("bad_message");
  return Array.from({ length: nSig }, (_, i) => bs58.encode(msg.subarray(o + i * 32, o + (i + 1) * 32)));
}

/** Unsigned/partially signed transaction: signature slots + message. */
export function assembleTx(msg: Uint8Array, sigs: (Uint8Array | null)[]): Uint8Array {
  const head = writeCompactU16(sigs.length);
  const out = new Uint8Array(head.length + sigs.length * 64 + msg.length);
  out.set(head, 0);
  sigs.forEach((s, i) => { if (s) out.set(s, head.length + i * 64); });
  out.set(msg, head.length + sigs.length * 64);
  return out;
}

export function splitTx(tx: Uint8Array): { sigs: Uint8Array[]; message: Uint8Array } {
  const [n, l] = readCompactU16(tx, 0);
  if (n < 1 || n > 8 || l + n * 64 >= tx.length) throw new Error("bad_tx");
  const sigs = Array.from({ length: n }, (_, i) => tx.slice(l + i * 64, l + (i + 1) * 64));
  return { sigs, message: tx.slice(l + n * 64) };
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export const b64 = { enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)), dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };

/** Ed25519 check of every required signature over the exact message bytes (WebCrypto). */
export async function verifyAllSignatures(tx: Uint8Array): Promise<{ ok: boolean; signers: string[]; message: Uint8Array; firstSignature: string }> {
  const { sigs, message } = splitTx(tx);
  const signers = messageSigners(message);
  if (signers.length !== sigs.length) return { ok: false, signers, message, firstSignature: "" };
  for (let i = 0; i < sigs.length; i++) {
    const key = await crypto.subtle.importKey("raw", bs58.decode(signers[i]!), { name: "Ed25519" } as any, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" } as any, key, sigs[i]!, message))) return { ok: false, signers, message, firstSignature: "" };
  }
  return { ok: true, signers, message, firstSignature: bs58.encode(sigs[0]!) };
}
