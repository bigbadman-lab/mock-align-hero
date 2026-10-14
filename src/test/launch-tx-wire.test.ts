import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { assembleTx, messageSigners, sameBytes, splitTx, verifyAllSignatures } from "@/lib/launch/tx-wire";

function build() {
  const creator = Keypair.generate(), mint = Keypair.generate();
  const ix = SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: mint.publicKey, lamports: 1, space: 0, programId: new PublicKey("11111111111111111111111111111111") });
  const msg = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
  return { creator, mint, bytes: msg.serialize() };
}

describe("launch transaction wire format", () => {
  it("lists creator then mint as the only signers", () => {
    const { creator, mint, bytes } = build();
    expect(messageSigners(bytes)).toEqual([creator.publicKey.toBase58(), mint.publicKey.toBase58()]);
  });
  it("accepts a transaction only when both signatures are valid over the unchanged message", async () => {
    const { creator, mint, bytes } = build();
    const tx = VersionedTransaction.deserialize(assembleTx(bytes, [null, null]));
    tx.sign([mint, creator]);
    const ser = tx.serialize();
    expect(sameBytes(splitTx(ser).message, bytes)).toBe(true);
    expect((await verifyAllSignatures(ser)).ok).toBe(true);
    const half = VersionedTransaction.deserialize(assembleTx(bytes, [null, null])); half.sign([mint]);
    expect((await verifyAllSignatures(half.serialize())).ok).toBe(false);
  });
});
