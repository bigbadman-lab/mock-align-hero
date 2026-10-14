// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, AddressLookupTableProgram, TransactionInstruction, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { splitTx } from "@/lib/launch/tx-wire";
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
  it("accepts the wallet-modified create Phantom actually returned (priority fee + Lighthouse)", () => {
    const raw = Uint8Array.from(atob(PHANTOM), (c) => c.charCodeAt(0));
    const r = validateAltMessage(splitTx(raw).message);
    expect(r.ok && r.tx.kind).toBe("create");
  });
  it("rejects a priority fee above 0.001 SOL", () => {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), createIx];
    expect(validateAltMessage(msg(auth, ixs))).toEqual({ ok: false, code: "PRIORITY_FEE_TOO_HIGH" });
  });
  it("rejects freeze/deactivate/close", () => {
    const f = AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: auth });
    expect(validateAltMessage(msg(auth, [f])).ok).toBe(false);
  });
});

const PHANTOM = "AYMXJRvTgUMTfREgooVRxF1dw+PmDr9xo45n/eYo//Zq0XVoPL7FCRt1/rACWPcmlB4BhCM2rMmXPFvQDkfqew+AAQAEBhdGmitJQrhAR6qTMRH+M+REHVo9c/gxvr2fpOQQqbuLGJBhqSTXQTWwfqGJ3igZzKrliNO4LbBmWtSII1dl/DIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ3pq+XM5t6yI0YkskERvUAAjCSZvYuU8EYJEmCAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAE3615Yv+x3ZJdCp+15tAM5hlbqLs6kf0H75hgxel7uADyMUoz69dFc+4MJZq31E0NxcMAT39HW5cRUMwYv5cTBQQABQJADQMABAAJA9i4BQAAAAAABQEBDQYEAQAAAAAAAAAAAAADBAEAAAINAAAAALMfOxsAAAAA/QUBABoGBAMAYBYABQAAAAAEAwAAAQAAAAAAAAAAAAA=";
