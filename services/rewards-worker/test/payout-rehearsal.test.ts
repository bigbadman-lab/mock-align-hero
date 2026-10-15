import { describe, expect, it } from "bun:test";
import { isRehearsalTx, REHEARSAL_RECIPIENTS, REHEARSAL_LAMPORTS_EACH, REHEARSAL_TOTAL_CAP } from "../src/payout-rehearsal";
const D = "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2";
const keys = [D, ...REHEARSAL_RECIPIENTS, "11111111111111111111111111111111"];
const pre = [1e9, 0, 0, 0, 1], each = Number(REHEARSAL_LAMPORTS_EACH);
describe("payout rehearsal", () => {
  it("pays 0.001 SOL to each of 3 wallets, capped at 0.003 SOL", () => {
    expect(REHEARSAL_LAMPORTS_EACH).toBe(1_000_000n); expect(REHEARSAL_RECIPIENTS.length).toBe(3); expect(REHEARSAL_TOTAL_CAP).toBe(3_000_000n);
  });
  it("recognises only an exact deployer-paid rehearsal", () => {
    const post = [pre[0]! - 3 * each - 5000, each, each, each, 1];
    expect(isRehearsalTx({ keys, pre, post, err: null }, D)).toBe(true);
    expect(isRehearsalTx({ keys, pre, post: [...post.slice(0, 3), 2 * each, 1], err: null }, D)).toBe(false);
    expect(isRehearsalTx({ keys, pre, post, err: { x: 1 } }, D)).toBe(false);
    expect(isRehearsalTx({ keys: [keys[1]!, D, ...keys.slice(2)], pre, post, err: null }, D)).toBe(false);
  });
});

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58"; import { createPublicKey, verify } from "node:crypto";
import { loadSigner, TECHNICAL_LIMITS } from "../src/signer";
import { assemble, solPayoutIxs } from "../src/assembly";
it("signer produces a signature that verifies against the deployer key", async () => {
  const k = Keypair.generate();
  const s = loadSigner({ MCPX_DEPLOYER_PRIVATE_KEY: bs58.encode(k.secretKey), MCPX_DEPLOYER_PUBLIC_KEY: k.publicKey.toBase58() });
  const rows = [{ owner: Keypair.generate().publicKey.toBase58(), amount: 1000n }];
  const u = assemble(solPayoutIxs(k.publicKey, [{ owner: rows[0]!.owner, lamports: 1000n }]), k.publicKey, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }, { cuLimit: 50000, cuPriceMicroLamports: 1000, allowedSigners: [k.publicKey.toBase58()] }) as { messageBase64: string };
  let b64 = "";
  const r = await s.sign!({ kind: "SOL_PAYOUT", idempotencyKey: "k", cycleId: "c", epoch: 300, messageBase64: u.messageBase64, lastValidBlockHeight: 1000, rows },
    { limits: { maxLamportsPerTx: null, maxLamportsPerCycle: null, maxTokensPerTx: null, ...TECHNICAL_LIMITS }, emergencyStop: false, currentBlockHeight: 1,
      store: { reserve: async () => "NEW", cycleSpent: async () => 0n, recordSigned: async (_k, _s, b) => { b64 = b; } } });
  expect(r.ok).toBe(true);
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), k.publicKey.toBuffer()]);
  expect(verify(null, Buffer.from(tx.message.serialize()), createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(tx.signatures[0]!))).toBe(true);
});
