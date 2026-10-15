import { describe, it, expect } from "bun:test";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { loadSigner } from "../src/signer";
import { TOKEN_2022, type ChildRecord } from "../src/child-fees";
const k = () => Keypair.generate().publicKey.toBase58();
const kp = Keypair.generate();
const s = loadSigner({ MCPX_DEPLOYER_PRIVATE_KEY: bs58.encode(kp.secretKey), MCPX_DEPLOYER_PUBLIC_KEY: kp.publicKey.toBase58() });
const c: ChildRecord = { mint: k(), creator: k(), ops: k(), platform: k(), quoteMint: k(), quoteTokenProgram: TOKEN_2022, sharingConfig: k() };
const sh = [{ address: c.creator, shareBps: 6000 }, { address: c.ops, shareBps: 2500 }, { address: c.platform, shareBps: 1500 }];
const bh = bs58.encode(Keypair.generate().publicKey.toBytes());
describe("child-fee signing", () => {
  it("signs a valid sweep/distribute with the deployer as sole signer", async () => {
    const r = await s.signChild!(c, sh, false, bh, 100);
    const tx = VersionedTransaction.deserialize(Buffer.from(r.signedBase64, "base64"));
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(kp.publicKey.toBase58());
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(bs58.encode(tx.signatures[0]!)).toBe(r.signature);
  });
  it("refuses when shareholders differ from the 60% creator record", async () => {
    await expect(s.signChild!(c, [{ address: k(), shareBps: 6000 }, sh[1]!, sh[2]!], false, bh, 100)).rejects.toThrow(/CHILD_TX_REFUSED/);
  });
});
