import { describe, it, expect } from "bun:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022, type ChildRecord } from "../src/child-fees";
import { buildChildDistribution, checkChildTx } from "../src/child-fees-build";
const k = () => Keypair.generate().publicKey.toBase58();
const MCP = k();
const mk = (): ChildRecord => ({ mint: k(), creator: k(), ops: k(), platform: k(), quoteMint: MCP, quoteTokenProgram: TOKEN_2022, sharingConfig: k() });
const onchain = (c: ChildRecord) => ({ sharingConfig: { shareholders: [{ address: c.creator, shareBps: 6000 }, { address: c.ops, shareBps: 2500 }, { address: c.platform, shareBps: 1500 }] } });
describe("transaction construction (official SDK, Token-2022 quote)", () => {
  it("bonding curve: sweep → distribute; graduated: AMM transfer first; strict check passes", async () => {
    const c = mk(), keeper = k(), sh = onchain(c).sharingConfig!.shareholders;
    for (const g of [false, true]) {
      const ixs = await buildChildDistribution(c, keeper, sh, g);
      expect(ixs.length).toBe(g ? 4 : 3);
      expect(checkChildTx(ixs, keeper, c, g)).toEqual({ ok: true });
      expect(ixs.flatMap((i) => i.keys).some((x) => x.pubkey.toBase58() === TOKEN_2022)).toBe(true);
    }
  });
  it("refuses an added transfer, a wrong shape or a missing recipient", async () => {
    const c = mk(), keeper = k(), sh = onchain(c).sharingConfig!.shareholders;
    const ixs = await buildChildDistribution(c, keeper, sh, false);
    expect(checkChildTx([...ixs, SystemProgram.transfer({ fromPubkey: new PublicKey(keeper), toPubkey: new PublicKey(k()), lamports: 1 })], keeper, c, false)).toMatchObject({ ok: false });
    expect(checkChildTx(ixs, keeper, c, true)).toMatchObject({ code: "SHAPE_MISMATCH" });
    const other = { ...c, platform: k() };
    expect(checkChildTx(ixs, keeper, other, false)).toMatchObject({ code: "RECIPIENT_MISSING" });
  });
});

