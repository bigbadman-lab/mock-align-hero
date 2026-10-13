// EXEC-01B READ-ONLY mainnet probe. Builds unsigned txs from real stand-in Pump coins and runs
// simulateTransaction(sigVerify:false, replaceRecentBlockhash). Never signs, never sends.
import { Connection, Keypair, PublicKey, VersionedTransaction, VersionedMessage } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { canonicalPumpPoolPda, OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { assemble, collectionInstructions, curveBuyInstructions, ammCollectInstructions, ammBuyInstructions, solPayoutIxs, tokenPayoutIxs, batchBySize, mintTokenProgram } from "../src/assembly";

const conn = new Connection(process.env["RPC"] ?? "https://api.mainnet-beta.solana.com", "finalized");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const out: Record<string, unknown> = { at: new Date().toISOString(), network: "mainnet-beta", signedOrSent: 0 };
const sim = async (b64: string) => {
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(b64, "base64")));
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" });
  return { err: r.value.err, cu: r.value.unitsConsumed ?? null, logsTail: (r.value.logs ?? []).slice(-2) };
};
const bh = await conn.getLatestBlockhash("finalized");
const run = async (name: string, f: () => Promise<unknown>) => { try { out[name] = await f(); } catch (e) { out[name] = { kind: "ERROR", error: e instanceof Error ? e.message.slice(0, 200) : String(e) }; } };
const pack = async (ixs: Parameters<typeof assemble>[0], payer: PublicKey, cu: number) => {
  const u = assemble(ixs, payer, bh, { cuLimit: cu, cuPriceMicroLamports: 1000, allowedSigners: [payer.toBase58()] });
  return u.kind === "UNSIGNED" ? { bytes: u.bytes, signers: u.signers.length, programs: u.programs, sim: await sim(u.messageBase64) } : u;
};

// Stand-in A: a recent bonding-curve Token-2022 coin (create_v2) and its creator.
let curveMint: PublicKey | null = null, curveCreator: PublicKey | null = null;
for (const s of await conn.getSignaturesForAddress(PUMP, { limit: 60 }, "finalized")) {
  if (s.err) continue;
  const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" }).catch(() => null);
  const m = t?.meta?.postTokenBalances?.find((b) => b.mint.endsWith("pump") && b.programId === TOKEN_2022_PROGRAM_ID.toBase58());
  if (!m || !t) continue;
  curveMint = new PublicKey(m.mint); curveCreator = t.transaction.message.staticAccountKeys[0]!; break;
}
out["standInCurve"] = { mint: curveMint?.toBase58() ?? null, payer: curveCreator?.toBase58() ?? null,
  tokenProgram: curveMint ? (await mintTokenProgram(conn, curveMint))?.toBase58() ?? null : null };

if (curveMint && curveCreator) {
  await run("curveCollect", async () => { const c = await collectionInstructions(conn, curveCreator!); return pack(c.ixs, curveCreator!, 200_000); });
  await run("curveBuyback", async () => { const b = await curveBuyInstructions(conn, curveMint!, curveCreator!, { budgetLamports: 1_000_000n, maxSlippageBps: 300, minOutTokens: 1n }, TOKEN_2022_PROGRAM_ID);
    return b.kind === "OK" ? { expectedTokens: String(b.expectedTokens), ...(await pack(b.ixs, curveCreator!, 300_000)) } : b; });
  await run("token2022Payout", async () => {
    // pay FROM a real holder wallet of the stand-in mint so the source Token-2022 ATA exists (simulation only)
    const big = await conn.getTokenLargestAccounts(curveMint!, "finalized");
    let holder: PublicKey | null = null, have = 0n;
    for (const a of big.value) { const i = await conn.getParsedAccountInfo(a.address, "finalized"); const info = (i.value?.data as { parsed?: { info?: { owner?: string; tokenAmount?: { amount?: string } } } })?.parsed?.info;
      const o = info?.owner ? new PublicKey(info.owner) : null; if (o && PublicKey.isOnCurve(o.toBytes())) { holder = o; have = BigInt(info?.tokenAmount?.amount ?? "0"); break; } }
    if (!holder) return { kind: "BLOCKED", reason: "NO_ON_CURVE_HOLDER" };
    out["token2022PayoutSource"] = { wallet: holder.toBase58(), balance: String(have) };
    const payer = holder;
    const rows = Array.from({ length: 30 }, () => ({ owner: Keypair.generate().publicKey.toBase58(), amount: 1000n, ataExists: false }));
    const tb = batchBySize(rows, (p) => assemble(tokenPayoutIxs(payer, curveMint!, 6, p, TOKEN_2022_PROGRAM_ID).ixs, payer, bh, { cuLimit: 400_000, cuPriceMicroLamports: 1000, allowedSigners: [payer.toBase58()] }));
    if (tb.kind !== "OK") return tb;
    return { recipients: 30, batches: tb.batches.length, bytes: tb.batches.map((x) => x.bytes), firstBatchSim: await sim(tb.batches[0]!.messageBase64),
      note: "source = real on-curve holder of a Token-2022 Pump coin; recipients are fresh keys needing ATA creation" };
  });
  await run("solPayout", async () => {
    const rows = Array.from({ length: 40 }, () => ({ owner: Keypair.generate().publicKey.toBase58(), lamports: 1_000_000n }));
    const sb = batchBySize(rows, (p) => assemble(solPayoutIxs(curveCreator!, p), curveCreator!, bh, { cuLimit: 50_000, cuPriceMicroLamports: 1000, allowedSigners: [curveCreator!.toBase58()] }));
    return sb.kind === "OK" ? { recipients: 40, batches: sb.batches.length, bytes: sb.batches.map((x) => x.bytes), firstBatchSim: await sim(sb.batches[0]!.messageBase64) } : sb;
  });
}

// Stand-in B: a graduated SOL-paired coin on its canonical PumpSwap pool.
let GRAD = new PublicKey("11111111111111111111111111111111");
for (const s of await conn.getSignaturesForAddress(new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"), { limit: 60 }, "finalized")) {
  if (s.err) continue;
  const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" }).catch(() => null);
  const ms = [...new Set((t?.meta?.postTokenBalances ?? []).map((b) => b.mint).filter((m) => m.endsWith("pump")))];
  let hit = false;
  for (const m of ms) { const pk = new PublicKey(m); if (await conn.getAccountInfo(canonicalPumpPoolPda(pk), "finalized")) { GRAD = pk; hit = true; break; } }
  if (hit) break;
}
await run("standInAmm", async () => { const pool = canonicalPumpPoolPda(GRAD); const p = await new OnlinePumpAmmSdk(conn).fetchPool(pool);
  out["ammCreator"] = p.coinCreator.toBase58(); return { mint: GRAD.toBase58(), pool: pool.toBase58(), coinCreator: p.coinCreator.toBase58(), tokenProgram: (await mintTokenProgram(conn, GRAD))?.toBase58() ?? null }; });
const ammCreator = out["ammCreator"] ? new PublicKey(String(out["ammCreator"])) : null;
if (ammCreator) {
  await run("ammCollect", async () => { const c = await ammCollectInstructions(conn, ammCreator); return c.kind === "OK" ? pack(c.ixs, ammCreator, 200_000) : c; });
  await run("ammBuyback", async () => { const b = await ammBuyInstructions(conn, GRAD, ammCreator, { budgetLamports: 1_000_000n, maxSlippageBps: 300, minOutTokens: 1n });
    return b.kind === "OK" ? { pool: b.pool, expectedTokens: String(b.expectedTokens), minOut: String(b.minOutTokens), ...(await pack(b.ixs, ammCreator, 300_000)) } : b; });
}
console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v), 2));
