// scripts/exec01b-probe.ts
import { Connection, Keypair, PublicKey as PublicKey2, VersionedTransaction as VersionedTransaction2, VersionedMessage } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID as TOKEN_2022_PROGRAM_ID2 } from "@solana/spl-token";
import { canonicalPumpPoolPda as canonicalPumpPoolPda2, OnlinePumpAmmSdk as OnlinePumpAmmSdk2 } from "@pump-fun/pump-swap-sdk";

// src/assembly.ts
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, creatorVaultPda, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
var MAX_TX_BYTES = 1232;
var MAX_CU = 14e5;
var PROGRAM_ALLOWLIST = /* @__PURE__ */ new Set([
  SystemProgram.programId.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  PUMP_PROGRAM_ID.toBase58(),
  PUMP_AMM_PROGRAM_ID.toBase58(),
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
  // Pump fee program (referenced by buy/collect)
]);
function assemble(ixs, payer, bh2, opts) {
  if (!(opts.cuLimit > 0 && opts.cuLimit <= MAX_CU)) return { kind: "BLOCKED", reason: "CU_LIMIT_OUT_OF_RANGE" };
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.cuPriceMicroLamports }),
    ...ixs
  ];
  const programs = [...new Set(all.map((i) => i.programId.toBase58()))];
  const bad = programs.find((p) => !PROGRAM_ALLOWLIST.has(p));
  if (bad) return { kind: "BLOCKED", reason: `PROGRAM_NOT_ALLOWED:${bad}` };
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh2.blockhash, instructions: all }).compileToV0Message();
  const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  const extra = signers.find((s) => !opts.allowedSigners.includes(s));
  if (extra) return { kind: "BLOCKED", reason: `UNEXPECTED_SIGNER:${extra}` };
  const tx = new VersionedTransaction(msg);
  let bytes;
  try {
    bytes = tx.serialize().length;
  } catch {
    return { kind: "BLOCKED", reason: "TX_TOO_LARGE:overrun" };
  }
  if (bytes > MAX_TX_BYTES) return { kind: "BLOCKED", reason: `TX_TOO_LARGE:${bytes}` };
  return {
    kind: "UNSIGNED",
    messageBase64: Buffer.from(msg.serialize()).toString("base64"),
    bytes,
    signers,
    programs,
    recentBlockhash: bh2.blockhash,
    lastValidBlockHeight: bh2.lastValidBlockHeight,
    computeUnitLimit: opts.cuLimit
  };
}
async function collectionInstructions(conn2, deployer) {
  const sdk = new OnlinePumpSdk(conn2);
  const ixs = await sdk.collectCoinCreatorFeeInstructions(deployer, deployer);
  const curveVault = creatorVaultPda(deployer);
  return { ixs, curveVault: curveVault.toBase58() };
}
async function curveBuyInstructions(conn2, mint, buyer, b, tokenProgram = TOKEN_2022_PROGRAM_ID) {
  if (b.budgetLamports <= 0n) return { kind: "BLOCKED", reason: "ZERO_BUDGET" };
  if (b.maxSlippageBps < 1 || b.maxSlippageBps > 500) return { kind: "BLOCKED", reason: "SLIPPAGE_OUT_OF_RANGE" };
  const sdk = new OnlinePumpSdk(conn2);
  const global = await sdk.fetchGlobal();
  const feeConfig = await sdk.fetchFeeConfig().catch(() => null);
  const st = await sdk.fetchBuyState(mint, buyer, tokenProgram);
  if (st.bondingCurve.complete) return { kind: "BLOCKED", reason: "CURVE_COMPLETE_AMM_BUY_ROUTE_NOT_IMPLEMENTED" };
  const sol = new BN(b.budgetLamports.toString());
  const out2 = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: sol, quoteMint: st.quoteMint ?? NATIVE_MINT });
  const expected = BigInt(out2.toString());
  if (expected < b.minOutTokens) return { kind: "BLOCKED", reason: "QUOTE_BELOW_MIN_OUT" };
  const ixs = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: st.bondingCurveAccountInfo,
    bondingCurve: st.bondingCurve,
    associatedUserAccountInfo: st.associatedUserAccountInfo,
    mint,
    user: buyer,
    amount: out2,
    solAmount: sol,
    slippage: b.maxSlippageBps / 100,
    tokenProgram
  });
  return { kind: "OK", ixs, expectedTokens: expected, maxSolCost: b.budgetLamports + b.budgetLamports * BigInt(b.maxSlippageBps) / 10000n };
}
function solPayoutIxs(from, rows) {
  const seen = /* @__PURE__ */ new Set();
  return rows.map((r) => {
    if (seen.has(r.owner)) throw new Error("duplicate_owner");
    seen.add(r.owner);
    if (r.lamports <= 0n) throw new Error("non_positive_amount");
    return SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(r.owner), lamports: r.lamports });
  });
}
async function mintTokenProgram(conn2, mint) {
  const a = await conn2.getAccountInfo(mint, "finalized");
  const o = a?.owner.toBase58();
  return o === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : o === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : null;
}
function tokenPayoutIxs(from, mint, decimals, rows, tokenProgram = TOKEN_2022_PROGRAM_ID) {
  const src = getAssociatedTokenAddressSync(mint, from, false, tokenProgram);
  const seen = /* @__PURE__ */ new Set();
  const ixs = [];
  let atasCreated = 0;
  for (const r of rows) {
    if (seen.has(r.owner)) throw new Error("duplicate_owner");
    seen.add(r.owner);
    if (r.amount <= 0n) throw new Error("non_positive_amount");
    const owner = new PublicKey(r.owner);
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error("off_curve_owner_requires_review");
    const dst = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    if (!r.ataExists) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, dst, owner, mint, tokenProgram));
      atasCreated++;
    }
    ixs.push(createTransferCheckedInstruction(src, mint, dst, from, r.amount, decimals, [], tokenProgram));
  }
  return { ixs, atasCreated };
}
function batchBySize(rows, build, maxPerBatch = 20) {
  const sorted = [...rows].sort((a, b) => a.owner < b.owner ? -1 : 1);
  const out2 = [];
  let i = 0;
  while (i < sorted.length) {
    let n = Math.min(maxPerBatch, sorted.length - i), got = null;
    for (; n >= 1; n--) {
      const r = build(sorted.slice(i, i + n));
      if (r.kind === "UNSIGNED") {
        got = r;
        break;
      }
    }
    if (!got) return { kind: "BLOCKED", reason: "SINGLE_RECIPIENT_TOO_LARGE", at: i };
    out2.push(got);
    i += n;
  }
  return { kind: "OK", batches: out2 };
}
async function ammCollectInstructions(conn2, deployer) {
  const sdk = new OnlinePumpAmmSdk(conn2);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, deployer, false, TOKEN_PROGRAM_ID);
  const pre = await conn2.getTokenAccountBalance(ata, "finalized").then((b) => BigInt(b.value.amount)).catch(() => 0n);
  if (pre !== 0n) return { kind: "BLOCKED", reason: "WSOL_UNACCOUNTED_BALANCE" };
  const st = await sdk.collectCoinCreatorFeeSolanaState(deployer);
  const ixs = await PUMP_AMM_SDK.collectCoinCreatorFee(st, deployer);
  return { kind: "OK", ixs };
}
async function ammBuyInstructions(conn2, mint, buyer, b) {
  if (b.budgetLamports <= 0n) return { kind: "BLOCKED", reason: "ZERO_BUDGET" };
  if (b.maxSlippageBps < 1 || b.maxSlippageBps > 500) return { kind: "BLOCKED", reason: "SLIPPAGE_OUT_OF_RANGE" };
  const pool = canonicalPumpPoolPda(mint);
  const sdk = new OnlinePumpAmmSdk(conn2);
  const st = await sdk.swapSolanaState(pool, buyer).catch(() => null);
  if (!st || !st.poolAccountInfo) return { kind: "BLOCKED", reason: "CANONICAL_POOL_MISSING" };
  if (!st.pool.baseMint.equals(mint) || !st.pool.quoteMint.equals(NATIVE_MINT)) return { kind: "BLOCKED", reason: "POOL_MINT_MISMATCH" };
  if (st.poolAccountInfo.owner.toBase58() !== PUMP_AMM_PROGRAM_ID.toBase58()) return { kind: "BLOCKED", reason: "POOL_PROGRAM_MISMATCH" };
  const base = BigInt(st.poolBaseAmount.toString()), quote = BigInt(st.poolQuoteAmount.toString());
  if (base === 0n || quote === 0n) return { kind: "BLOCKED", reason: "INSUFFICIENT_LIQUIDITY" };
  if (b.budgetLamports * 20n > quote) return { kind: "BLOCKED", reason: "PRICE_IMPACT_TOO_HIGH" };
  const est = base * b.budgetLamports / (quote + b.budgetLamports);
  const minOut = est * BigInt(1e4 - b.maxSlippageBps) / 10000n;
  if (minOut < b.minOutTokens || minOut <= 0n) return { kind: "BLOCKED", reason: "QUOTE_BELOW_MIN_OUT" };
  const ixs = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(st, new BN(b.budgetLamports.toString()), new BN(minOut.toString()));
  return { kind: "OK", ixs, pool: pool.toBase58(), expectedTokens: est, minOutTokens: minOut, baseTokenProgram: st.baseTokenProgram.toBase58() };
}

// scripts/exec01b-probe.ts
var conn = new Connection(process.env["RPC"] ?? "https://api.mainnet-beta.solana.com", "finalized");
var PUMP = new PublicKey2("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
var out = { at: (/* @__PURE__ */ new Date()).toISOString(), network: "mainnet-beta", signedOrSent: 0 };
var sim = async (b64) => {
  const tx = new VersionedTransaction2(VersionedMessage.deserialize(Buffer.from(b64, "base64")));
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" });
  return { err: r.value.err, cu: r.value.unitsConsumed ?? null, logsTail: (r.value.logs ?? []).slice(-2) };
};
var bh = await conn.getLatestBlockhash("finalized");
var run = async (name, f) => {
  try {
    out[name] = await f();
  } catch (e) {
    out[name] = { kind: "ERROR", error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
};
var pack = async (ixs, payer, cu) => {
  const u = assemble(ixs, payer, bh, { cuLimit: cu, cuPriceMicroLamports: 1e3, allowedSigners: [payer.toBase58()] });
  return u.kind === "UNSIGNED" ? { bytes: u.bytes, signers: u.signers.length, programs: u.programs, sim: await sim(u.messageBase64) } : u;
};
var curveMint = null;
var curveCreator = null;
for (const s of await conn.getSignaturesForAddress(PUMP, { limit: 60 }, "finalized")) {
  if (s.err) continue;
  const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" }).catch(() => null);
  const m = t?.meta?.postTokenBalances?.find((b) => b.mint.endsWith("pump") && b.programId === TOKEN_2022_PROGRAM_ID2.toBase58());
  if (!m || !t) continue;
  curveMint = new PublicKey2(m.mint);
  curveCreator = t.transaction.message.staticAccountKeys[0];
  break;
}
out["standInCurve"] = {
  mint: curveMint?.toBase58() ?? null,
  payer: curveCreator?.toBase58() ?? null,
  tokenProgram: curveMint ? (await mintTokenProgram(conn, curveMint))?.toBase58() ?? null : null
};
if (curveMint && curveCreator) {
  await run("curveCollect", async () => {
    const c = await collectionInstructions(conn, curveCreator);
    return pack(c.ixs, curveCreator, 2e5);
  });
  await run("curveBuyback", async () => {
    const b = await curveBuyInstructions(conn, curveMint, curveCreator, { budgetLamports: 1000000n, maxSlippageBps: 300, minOutTokens: 1n }, TOKEN_2022_PROGRAM_ID2);
    return b.kind === "OK" ? { expectedTokens: String(b.expectedTokens), ...await pack(b.ixs, curveCreator, 3e5) } : b;
  });
  await run("token2022Payout", async () => {
    const rows = Array.from({ length: 30 }, () => ({ owner: Keypair.generate().publicKey.toBase58(), amount: 1000n, ataExists: false }));
    const tb = batchBySize(rows, (p) => assemble(tokenPayoutIxs(curveCreator, curveMint, 6, p, TOKEN_2022_PROGRAM_ID2).ixs, curveCreator, bh, { cuLimit: 4e5, cuPriceMicroLamports: 1e3, allowedSigners: [curveCreator.toBase58()] }));
    if (tb.kind !== "OK") return tb;
    return {
      recipients: 30,
      batches: tb.batches.length,
      bytes: tb.batches.map((x) => x.bytes),
      firstBatchSim: await sim(tb.batches[0].messageBase64),
      note: "stand-in payer holds none of this mint, so a funds error in TransferChecked is expected; size/accounts/ATA creation are what this proves"
    };
  });
  await run("solPayout", async () => {
    const rows = Array.from({ length: 40 }, () => ({ owner: Keypair.generate().publicKey.toBase58(), lamports: 1000000n }));
    const sb = batchBySize(rows, (p) => assemble(solPayoutIxs(curveCreator, p), curveCreator, bh, { cuLimit: 5e4, cuPriceMicroLamports: 1e3, allowedSigners: [curveCreator.toBase58()] }));
    return sb.kind === "OK" ? { recipients: 40, batches: sb.batches.length, bytes: sb.batches.map((x) => x.bytes), firstBatchSim: await sim(sb.batches[0].messageBase64) } : sb;
  });
}
var GRAD = new PublicKey2(process.env["GRAD_MINT"] ?? "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
await run("standInAmm", async () => {
  const pool = canonicalPumpPoolPda2(GRAD);
  const p = await new OnlinePumpAmmSdk2(conn).fetchPool(pool);
  out["ammCreator"] = p.coinCreator.toBase58();
  return { mint: GRAD.toBase58(), pool: pool.toBase58(), coinCreator: p.coinCreator.toBase58(), tokenProgram: (await mintTokenProgram(conn, GRAD))?.toBase58() ?? null };
});
var ammCreator = out["ammCreator"] ? new PublicKey2(String(out["ammCreator"])) : null;
if (ammCreator) {
  await run("ammCollect", async () => {
    const c = await ammCollectInstructions(conn, ammCreator);
    return c.kind === "OK" ? pack(c.ixs, ammCreator, 2e5) : c;
  });
  await run("ammBuyback", async () => {
    const b = await ammBuyInstructions(conn, GRAD, ammCreator, { budgetLamports: 1000000n, maxSlippageBps: 300, minOutTokens: 1n });
    return b.kind === "OK" ? { pool: b.pool, expectedTokens: String(b.expectedTokens), minOut: String(b.minOutTokens), ...await pack(b.ixs, ammCreator, 3e5) } : b;
  });
}
console.log(JSON.stringify(out, (_, v) => typeof v === "bigint" ? String(v) : v, 2));
