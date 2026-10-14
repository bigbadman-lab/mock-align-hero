// CHILD-FEES-01B — child-fee keeper pass inside the Rewards Worker schedule. Isolated from native
// rewards: reads/writes only public.mcpx_cf_* (+ read-only mcp_creations) and never touches mcpx_rw_*.
// This gate is plan-only: signingEnabled=false, send=null, no keypair is passed in. No new wallet:
// the fee payer of record is the existing deployer public address.
import type { Db } from "../../../src/lib/rewards/store.pg";
import type { RpcCall } from "./pipeline";
import { runChildFeePass, verifyChild, verifyRecipients, TOKEN_2022, type ChildRecord, type ChildOutcome } from "./child-fees";
import { childStorePg, loadChildren, pendingRegistry, insertChild } from "./child-store.pg";
import { runLaunchVerifier, readLaunchTx, launchStorePg } from "./launch-verify";
import { readChild, balances, fetchFinal, finalizedBlockHeight, curveVaultOwner, mintOwner, sharingConfigOf } from "./child-chain";

export type ChildEnv = { launchVerifier: boolean; ops: string | null; platform: string | null; nativeDeployer: string | null; dailyGasLamports: bigint | null; minDistributable: bigint; estCostLamports: bigint };

export function readChildEnv(env: (k: string) => string | null): ChildEnv {
  const big = (k: string) => { const v = env(k); return v && /^\d{1,19}$/.test(v) ? BigInt(v) : null; };
  return {
    launchVerifier: env("MCPX_LAUNCH_VERIFIER") === "1", // needs migration 0025
    ops: env("MCPX_FEE_OPS_RECIPIENT"), platform: env("MCPX_FEE_PLATFORM_RECIPIENT"),
    nativeDeployer: env("MCPX_DEPLOYER_PUBLIC_KEY") ?? env("MCPX_NATIVE_DEPLOYER_PUBLIC_KEY"),
    dailyGasLamports: big("MCPX_CHILD_FEES_DAILY_GAS_LAMPORTS"),
    minDistributable: big("MCPX_CHILD_FEES_MIN_DISTRIBUTABLE") ?? 1n,
    estCostLamports: big("MCPX_CHILD_FEES_EST_COST_LAMPORTS") ?? 15_000n,
  };
}

/** Onboard registry products whose locked on-chain split already verifies; anything else stays out. */
export async function onboardChildren(db: Db, call: RpcCall, quote: string, e: ChildEnv): Promise<ChildOutcome[]> {
  const out: ChildOutcome[] = [];
  if (!e.ops || !e.platform || !e.nativeDeployer) return [{ mint: "*", result: "ONBOARD_HELD:AUTHORIZED_RECIPIENTS_UNSET" }];
  for (const p of await pendingRegistry(db, quote)) {
    const c: ChildRecord = { mint: p.child_mint, creator: p.creator_wallet, ops: e.ops, platform: e.platform, quoteMint: quote, quoteTokenProgram: (await mintOwner(call, quote)) ?? "", sharingConfig: sharingConfigOf(p.child_mint) };
    let v;
    try { const o = await readChild(call, c); v = verifyChild(c, o, quote); if (v.ok) v = verifyRecipients(c, o, p.creator_wallet, e); } catch { v = { ok: false as const, code: "EVIDENCE_UNAVAILABLE" }; }
    if (!v.ok) { out.push({ mint: c.mint, result: `ONBOARD_HELD:${v.code}` }); continue; }
    if (c.quoteTokenProgram !== TOKEN_2022) { out.push({ mint: c.mint, result: "ONBOARD_HELD:QUOTE_TOKEN_PROGRAM_MISMATCH" }); continue; }
    await insertChild(db, c, p.slot, p.verified_tx_signature);
    out.push({ mint: c.mint, result: "ONBOARDED" });
  }
  return out;
}

export async function childFeeCycle(db: Db, call: RpcCall, opts: { canonicalQuote: string | null; feePayer: string | null; env: ChildEnv; now?: () => number }): Promise<ChildOutcome[]> {
  const e = opts.env;
  if (!opts.canonicalQuote) return [{ mint: "*", result: "HELD:QUOTE_MINT_UNSET" }];
  if (!opts.feePayer) return [{ mint: "*", result: "HELD:FEE_PAYER_UNSET" }];
  // Post-launch verifier runs first so newly verified products are onboarded in the same pass.
  const launches = e.launchVerifier ? await runLaunchVerifier({
    ...launchStorePg(db),
    readTx: (sig) => readLaunchTx(call, sig),
    readChild: (c) => readChild(call, { mint: c.mint, creator: c.creator, ops: e.ops ?? "", platform: e.platform ?? "", quoteMint: opts.canonicalQuote!, quoteTokenProgram: TOKEN_2022, sharingConfig: sharingConfigOf(c.mint) }),
    quoteProgram: () => mintOwner(call, opts.canonicalQuote!),
    sharingConfigOf,
  }, opts.canonicalQuote, { ops: e.ops, platform: e.platform, nativeDeployer: e.nativeDeployer }).then((xs) => xs.map((x) => ({ mint: `claim:${x.claim}`, result: x.result })))
    : [];
  const onboard = await onboardChildren(db, call, opts.canonicalQuote, e).catch(() => [{ mint: "*", result: "ONBOARD_HELD:DISCOVERY_UNAVAILABLE" }]);
  const list = await loadChildren(db);
  const byMint = new Map(list.map((c) => [c.mint, c]));
  const pass = await runChildFeePass({
    now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
    canonicalQuote: opts.canonicalQuote, keeper: opts.feePayer,
    dailyGasLamports: e.dailyGasLamports, minDistributable: e.minDistributable,
    children: async () => list,
    readChild: (c) => readChild(call, c),
    balances: (c) => balances(call, c),
    estimateCost: async () => e.estCostLamports,
    buildAndSign: async () => { throw new Error("SIGNING_NOT_APPROVED"); }, // unreachable: signingEnabled=false
    send: null,
    fetchFinal: (s) => fetchFinal(call, s),
    finalizedBlockHeight: () => finalizedBlockHeight(call),
    vaultOwner: curveVaultOwner,
    childByMint: (m) => byMint.get(m),
    store: childStorePg(db),
    authorized: { ops: e.ops, platform: e.platform, nativeDeployer: e.nativeDeployer },
    registeredCreator: async (m) => byMint.get(m)?.registeredCreator ?? null,
    signingEnabled: false,
  });
  return [...launches, ...onboard, ...pass];
}
