// READ-ONLY mainnet probe: builds unsigned txs and runs simulateTransaction(sigVerify:false). Never signs or sends.
import { Connection, PublicKey, VersionedTransaction, VersionedMessage } from "@solana/web3.js";
import { assemble, collectionInstructions, curveBuyInstructions, solPayoutIxs, tokenPayoutIxs, batchBySize } from "../src/assembly";
const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "finalized");
const CREATOR = new PublicKey("6Vf3QXGdPm7os7p3UisqxVUVgSZswVK1wUDuVNikNK2x"); // real creator from 05-B fixture
const sim = async (b64: string) => {
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(b64, "base64")));
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" });
  return { err: r.value.err, cu: r.value.unitsConsumed, logsTail: (r.value.logs ?? []).slice(-3) };
};
const out: Record<string, unknown> = {};
const bh = await conn.getLatestBlockhash("finalized");
out.creatorBalance = await conn.getBalance(CREATOR, "finalized");
const c = await collectionInstructions(conn, CREATOR);
const cu = assemble(c.ixs, CREATOR, bh, { cuLimit: 200_000, cuPriceMicroLamports: 1000, allowedSigners: [CREATOR.toBase58()] });
out.collection = cu.kind === "UNSIGNED" ? { bytes: cu.bytes, signers: cu.signers, programs: cu.programs, ixCount: c.ixs.length, curveVault: c.curveVault,
  vaultLamports: await conn.getBalance(new PublicKey(c.curveVault), "finalized"), sim: await sim(cu.messageBase64) } : cu;
// find a live SOL bonding-curve coin from recent finalized Pump txs
const sigs = await conn.getSignaturesForAddress(new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), { limit: 25 }, "finalized");
let mint: string | null = null;
for (const s of sigs) { if (s.err) continue; const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
  const m = t?.meta?.postTokenBalances?.find((b) => b.mint.endsWith("pump") && b.programId === "TokenzQdBNbLqP5VEhdkAovAUFj3z9VhjndPDzdC3jmT"); if (m) { mint = m.mint; out.buyMintSourceSig = s.signature; break; } }
out.buyMint = mint;
if (mint) {
  const b = await curveBuyInstructions(conn, new PublicKey(mint), CREATOR, { budgetLamports: 1_000_000n, maxSlippageBps: 300, minOutTokens: 1n });
  if (b.kind === "OK") { const u = assemble(b.ixs, CREATOR, bh, { cuLimit: 300_000, cuPriceMicroLamports: 1000, allowedSigners: [CREATOR.toBase58()] });
    out.buy = u.kind === "UNSIGNED" ? { bytes: u.bytes, signers: u.signers, expectedTokens: String(b.expectedTokens), maxSolCost: String(b.maxSolCost), sim: await sim(u.messageBase64) } : u;
  } else out.buy = b;
  // token payout sizing (Token-2022) for N recipients needing ATA creation; fixture recipients
  const rows = Array.from({ length: 20 }, () => ({ owner: PublicKey.unique().toBase58(), amount: 1000n, ataExists: false }));
  const tb = batchBySize(rows, (p) => assemble(tokenPayoutIxs(CREATOR, new PublicKey(mint!), 6, p).ixs, CREATOR, bh, { cuLimit: 400_000, cuPriceMicroLamports: 1000, allowedSigners: [CREATOR.toBase58()] }));
  out.tokenPayoutBatching = tb.kind === "OK" ? tb.batches.map((x) => x.bytes) : tb;
}
const solRows = Array.from({ length: 40 }, () => ({ owner: PublicKey.unique().toBase58(), lamports: 1_000_000n }));
const sb = batchBySize(solRows, (p) => assemble(solPayoutIxs(CREATOR, p), CREATOR, bh, { cuLimit: 50_000, cuPriceMicroLamports: 1000, allowedSigners: [CREATOR.toBase58()] }));
out.solPayoutBatching = sb.kind === "OK" ? sb.batches.map((x) => x.bytes) : sb;
if (sb.kind === "OK") out.solPayoutSim = await sim(sb.batches[0]!.messageBase64);
console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v), 2));
