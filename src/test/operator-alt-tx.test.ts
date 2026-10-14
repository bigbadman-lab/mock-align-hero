// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AddressLookupTableProgram, TransactionInstruction, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { validateAltMessage } from "@/lib/operator/alt-tx";
import { ALT_AUTHORITY, STATIC_ALT_ENTRIES } from "@/lib/operator/alt-manifest";

const auth = new PublicKey(ALT_AUTHORITY);
const msg = (payer: PublicKey, ixs: TransactionInstruction[]) =>
  new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message().serialize();
const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: auth, payer: auth, recentSlot: 123 });
const ext = (addrs: string[], authority = auth) => AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority, payer: authority, addresses: addrs.map((a) => new PublicKey(a)) });
const all = STATIC_ALT_ENTRIES.map((e) => e.address);

describe("operator lookup-table transactions", () => {
  it("accepts the deployer's create", () => expect(validateAltMessage(msg(auth, [createIx]))).toEqual({ ok: true, tx: { kind: "create", table: table.toBase58(), recentSlot: 123 } }));
  it("accepts extend with the 13 manifest addresses", () => {
    const r = validateAltMessage(msg(auth, [ext(all)]));
    expect(r.ok && r.tx.kind === "extend" && r.tx.addresses).toEqual(all);
  });
  it("rejects an address outside the manifest", () => expect(validateAltMessage(msg(auth, [ext([...all.slice(0, 2), Keypair.generate().publicKey.toBase58()])]))).toEqual({ ok: false, code: "ADDRESS_NOT_IN_MANIFEST" }));
  it("rejects any other signer", () => { const k = Keypair.generate().publicKey; expect(validateAltMessage(msg(k, [ext(all, k)])).ok).toBe(false); });
  it("rejects an extra instruction (e.g. a SOL transfer)", () => expect(validateAltMessage(msg(auth, [createIx, SystemProgram.transfer({ fromPubkey: auth, toPubkey: Keypair.generate().publicKey, lamports: 1 })]))).toEqual({ ok: false, code: "ONE_INSTRUCTION_ONLY" }));
  it("rejects freeze/deactivate/close", () => {
    const f = AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: auth });
    expect(validateAltMessage(msg(auth, [f])).ok).toBe(false);
  });
});
