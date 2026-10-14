// CHILD-FEES-01B — child-token creator-fee keeper (isolated module inside Rewards Worker #3).
// Pure logic with injected chain/store. Child fees are paid by the Pump programs straight from the
// child's sharing-config creator vault to the three locked shareholders; the keeper only pays the
// network fee and (if needed) recipient-ATA rent. Nothing here touches the native 30/30/40 ledger
// (mcpx_rw_*), the deployer's own balances, or the native budget.

export const CHILD_SPLIT = Object.freeze({ creator: 6000, ops: 2500, platform: 1500 });
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type ChildRecord = { mint: string; creator: string; ops: string; platform: string; quoteMint: string; quoteTokenProgram: string; sharingConfig: string };
export type Shareholder = { address: string; shareBps: number };
export type OnchainChild = {
  sharingConfig: null | { mint: string; adminRevoked: boolean; shareholders: Shareholder[] };
  curveCreator: string | null; curveQuoteMint: string | null; quoteMintOwner: string | null;
  graduated: boolean | null;
};

export type VerifyResult = { ok: true } | { ok: false; code: string };

/** Locked recipients and exact 6000/2500/1500, read from chain — never from the database alone. */
export function verifyChild(c: ChildRecord, o: OnchainChild, canonicalQuote: string | null): VerifyResult {
  if (!canonicalQuote) return { ok: false, code: "QUOTE_MINT_UNSET" };
  if (c.quoteMint !== canonicalQuote) return { ok: false, code: "QUOTE_MINT_MISMATCH" };
  if (c.quoteTokenProgram !== TOKEN_2022 || o.quoteMintOwner !== TOKEN_2022) return { ok: false, code: "QUOTE_TOKEN_PROGRAM_MISMATCH" };
  const sc = o.sharingConfig;
  if (!sc) return { ok: false, code: "SHARING_CONFIG_MISSING" };
  if (sc.mint !== c.mint) return { ok: false, code: "SHARING_CONFIG_MINT_MISMATCH" };
  if (!sc.adminRevoked) return { ok: false, code: "SHARES_NOT_LOCKED" };
  if (o.curveCreator !== c.sharingConfig) return { ok: false, code: "CURVE_CREATOR_NOT_SHARING_CONFIG" };
  if (o.curveQuoteMint !== c.quoteMint) return { ok: false, code: "CURVE_QUOTE_MISMATCH" };
  if (o.graduated === null) return { ok: false, code: "GRADUATION_UNKNOWN" };
  const want = [[c.creator, CHILD_SPLIT.creator], [c.ops, CHILD_SPLIT.ops], [c.platform, CHILD_SPLIT.platform]] as const;
  if (new Set([c.creator, c.ops, c.platform]).size !== 3) return { ok: false, code: "RECIPIENT_DUPLICATE" };
  if (sc.shareholders.length !== 3) return { ok: false, code: "SHARES_MISMATCH" };
  for (let i = 0; i < 3; i++) {
    const s = sc.shareholders[i]!, w = want[i]!;
    if (s.address !== w[0] || s.shareBps !== w[1]) return { ok: false, code: "SHARES_MISMATCH" };
  }
  return { ok: true };
}

/** CREATOR_RECIPIENT_BINDING (keeper side): before any distribution the locked on-chain shareholders must
 * equal [registered product creator wallet 60%, server-authorized ops 25%, server-authorized platform 15%].
 * Every input must be present; anything missing is incomplete evidence and holds the child. */
export type AuthorizedRecipients = { ops: string | null; platform: string | null; nativeDeployer: string | null };
export function verifyRecipients(c: ChildRecord, o: OnchainChild, registeredCreator: string | null, a: AuthorizedRecipients): VerifyResult {
  if (!a.ops || !a.platform || !a.nativeDeployer) return { ok: false, code: "AUTHORIZED_RECIPIENTS_UNSET" };
  if (!registeredCreator) return { ok: false, code: "REGISTERED_CREATOR_MISSING" };
  const sh = o.sharingConfig?.shareholders;
  if (!sh || sh.length !== 3 || sh.some((x) => !x || typeof x.address !== "string" || typeof x.shareBps !== "number")) return { ok: false, code: "SHARES_EVIDENCE_INCOMPLETE" };
  if (registeredCreator === a.nativeDeployer || sh.some((x) => x.address === a.nativeDeployer)) return { ok: false, code: "NATIVE_DEPLOYER_AS_RECIPIENT" };
  const [s0, s1, s2] = sh as [Shareholder, Shareholder, Shareholder];
  if (s0.address !== registeredCreator || s0.shareBps !== CHILD_SPLIT.creator || c.creator !== registeredCreator) return { ok: false, code: "CREATOR_RECIPIENT_MISMATCH" };
  if (s1.address !== a.ops || s1.shareBps !== CHILD_SPLIT.ops || c.ops !== a.ops) return { ok: false, code: "OPS_RECIPIENT_MISMATCH" };
  if (s2.address !== a.platform || s2.shareBps !== CHILD_SPLIT.platform || c.platform !== a.platform) return { ok: false, code: "PLATFORM_RECIPIENT_MISMATCH" };
  return { ok: true };
}

export type PlanInput = {
  graduated: boolean;
  curveVaultQuote: bigint | null;   // sharing-config creator vault quote ATA balance (null = unknown)
  ammVaultQuote: bigint | null;     // PumpSwap coin-creator vault quote ATA balance (graduated only)
  minDistributable: bigint;         // operator minimum, in quote base units
  estCostLamports: bigint;          // network fee + worst-case recipient-ATA rent
  gasRemainingLamports: bigint | null; // approved child-fee operations gas budget left today (null = not configured)
};
export type PlanResult = { action: "DISTRIBUTE" | "SWEEP_THEN_DISTRIBUTE"; amount: bigint } | { action: "SKIP"; code: string };

export function planChild(p: PlanInput): PlanResult {
  if (p.gasRemainingLamports === null) return { action: "SKIP", code: "GAS_BUDGET_NOT_CONFIGURED" };
  if (p.curveVaultQuote === null || (p.graduated && p.ammVaultQuote === null)) return { action: "SKIP", code: "BALANCE_UNKNOWN" };
  const amount = p.curveVaultQuote + (p.graduated ? (p.ammVaultQuote as bigint) : 0n);
  if (amount <= 0n) return { action: "SKIP", code: "NOTHING_ACCRUED" };
  if (amount < p.minDistributable) return { action: "SKIP", code: "BELOW_MINIMUM" };
  if (p.estCostLamports > p.gasRemainingLamports) return { action: "SKIP", code: "GAS_BUDGET_EXHAUSTED" };
  return { action: p.graduated && (p.ammVaultQuote as bigint) > 0n ? "SWEEP_THEN_DISTRIBUTE" : "DISTRIBUTE", amount };
}

/** One identity per child per hour window: retries and parallel workers converge on the same key. */
export const childIntentKey = (mint: string, unixSeconds: number) => `cf:${mint}:${Math.floor(unixSeconds / 3600)}`;

export type TokenBal = { owner: string; mint: string; amount: bigint };
export type FinalTx = { finalized: boolean; err: unknown; slot: number; pre: TokenBal[]; post: TokenBal[]; feePayer: string };
export type SettleResult = { state: "PROVEN"; distributed: bigint; perRecipient: Record<string, bigint> } | { state: "MISMATCH" | "UNKNOWN"; code: string };

/** Finalized proof: each locked shareholder's quote balance rose by its bps share (±1 base unit of
 * rounding), the creator vault fell by the same total, and the keeper wallet received nothing. */
export function verifyChildSettlement(tx: FinalTx | null, c: ChildRecord, vaultOwner: string, keeper: string): SettleResult {
  if (!tx) return { state: "UNKNOWN", code: "TX_NOT_FOUND" };
  if (!tx.finalized) return { state: "UNKNOWN", code: "NOT_FINALIZED" };
  if (tx.err) return { state: "MISMATCH", code: "TX_FAILED" };
  if (tx.feePayer !== keeper) return { state: "MISMATCH", code: "FEE_PAYER_MISMATCH" };
  const bal = (list: TokenBal[], owner: string) => list.filter((b) => b.owner === owner && b.mint === c.quoteMint).reduce((a, b) => a + b.amount, 0n);
  const delta = (owner: string) => bal(tx.post, owner) - bal(tx.pre, owner);
  if (delta(keeper) !== 0n) return { state: "MISMATCH", code: "KEEPER_RECEIVED_FUNDS" };
  const vaultOut = -delta(vaultOwner);
  if (vaultOut <= 0n) return { state: "MISMATCH", code: "VAULT_NOT_DEBITED" };
  const per: Record<string, bigint> = {};
  let sum = 0n;
  for (const [who, bps] of [[c.creator, CHILD_SPLIT.creator], [c.ops, CHILD_SPLIT.ops], [c.platform, CHILD_SPLIT.platform]] as const) {
    const d = delta(who), exp = (vaultOut * BigInt(bps)) / 10_000n;
    if (d < 0n || d < exp - 1n || d > exp + 1n) return { state: "MISMATCH", code: "SHARE_DELTA_MISMATCH" };
    per[who] = d; sum += d;
  }
  if (sum !== vaultOut) return { state: "MISMATCH", code: "CONSERVATION_FAILED" };
  return { state: "PROVEN", distributed: vaultOut, perRecipient: per };
}

// ---- durable execution (store injected; production store = pending migration 0021 via the sealed bridge)
export type ChildIntent = { key: string; mint: string; status: "RESERVED" | "SIGNED" | "LANDED" | "FAILED" | "EXPIRED"; signature?: string; signedBase64?: string; lastValidBlockHeight?: number; costLamports: bigint };
export interface ChildStore {
  reserve(i: { key: string; mint: string; costLamports: bigint }): Promise<"RESERVED" | "DUPLICATE">;
  recordSigned(key: string, signature: string, signedBase64: string, lastValidBlockHeight: number): Promise<void>;
  open(): Promise<ChildIntent[]>;
  finalize(key: string, status: "LANDED" | "FAILED" | "EXPIRED", evidence: unknown): Promise<void>;
  gasSpentToday(): Promise<bigint>;
}

export function memoryChildStore(): ChildStore & { rows: Map<string, ChildIntent & { evidence?: unknown }> } {
  const rows = new Map<string, ChildIntent & { evidence?: unknown }>();
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => T) => { const p = lock.then(f); lock = p.catch(() => {}); return p; };
  return {
    rows,
    reserve: (i) => serial(() => { if (rows.has(i.key)) return "DUPLICATE" as const; rows.set(i.key, { ...i, status: "RESERVED" }); return "RESERVED" as const; }),
    recordSigned: (key, signature, signedBase64, lastValidBlockHeight) => serial(() => {
      const r = rows.get(key); if (!r || r.status !== "RESERVED") throw new Error("ILLEGAL_TRANSITION");
      Object.assign(r, { status: "SIGNED", signature, signedBase64, lastValidBlockHeight });
    }),
    open: () => serial(() => [...rows.values()].filter((r) => r.status === "RESERVED" || r.status === "SIGNED").map((r) => ({ ...r }))),
    finalize: (key, status, evidence) => serial(() => {
      const r = rows.get(key); if (!r || (r.status !== "SIGNED" && !(r.status === "RESERVED" && status === "EXPIRED"))) throw new Error("ILLEGAL_TRANSITION");
      Object.assign(r, { status, evidence });
    }),
    gasSpentToday: () => serial(() => [...rows.values()].filter((r) => r.status !== "EXPIRED").reduce((a, r) => a + r.costLamports, 0n)),
  };
}

export type KeeperDeps = {
  now: () => number;
  canonicalQuote: string | null;
  keeper: string;                                   // fee payer only
  dailyGasLamports: bigint | null;                  // env MCPX_CHILD_FEES_DAILY_GAS_LAMPORTS; unset = keeper holds
  minDistributable: bigint;
  children: () => Promise<ChildRecord[]>;           // verified MCPX-launched children only
  readChild: (c: ChildRecord) => Promise<OnchainChild>;
  balances: (c: ChildRecord) => Promise<{ curveVaultQuote: bigint | null; ammVaultQuote: bigint | null }>;
  estimateCost: (c: ChildRecord) => Promise<bigint>;
  buildAndSign: (c: ChildRecord, action: "DISTRIBUTE" | "SWEEP_THEN_DISTRIBUTE") => Promise<{ signature: string; signedBase64: string; lastValidBlockHeight: number }>;
  send: null | ((signedBase64: string) => Promise<void>); // null = broadcasting disabled (this gate)
  fetchFinal: (signature: string) => Promise<FinalTx | null>;
  finalizedBlockHeight: () => Promise<number | null>;
  vaultOwner: (c: ChildRecord) => string;
  childByMint: (mint: string) => ChildRecord | undefined;
  store: ChildStore;
  authorized: AuthorizedRecipients;                 // server env, never from the DB record
  registeredCreator: (mint: string) => Promise<string | null>; // mcp_creations.creator_wallet
};

async function recipientsOk(d: KeeperDeps, c: ChildRecord): Promise<VerifyResult & { onchain?: OnchainChild }> {
  try {
    const onchain = await d.readChild(c);
    const v = verifyChild(c, onchain, d.canonicalQuote);
    if (!v.ok) return v;
    const r = verifyRecipients(c, onchain, await d.registeredCreator(c.mint), d.authorized);
    return r.ok ? { ok: true, onchain } : r;
  } catch { return { ok: false, code: "EVIDENCE_UNAVAILABLE" }; }
}

export type ChildOutcome = { mint: string; result: string };

export async function reconcileChildren(d: KeeperDeps): Promise<ChildOutcome[]> {
  const out: ChildOutcome[] = [];
  const height = await d.finalizedBlockHeight().catch(() => null);
  for (const i of await d.store.open()) {
    const c = d.childByMint(i.mint);
    if (i.status === "RESERVED") { out.push({ mint: i.mint, result: "RESERVED_UNSIGNED" }); continue; }
    const tx = c ? await d.fetchFinal(i.signature!).catch(() => null) : null;
    const s = c ? verifyChildSettlement(tx, c, d.vaultOwner(c), d.keeper) : { state: "UNKNOWN" as const, code: "CHILD_UNKNOWN" };
    if (s.state === "PROVEN") { await d.store.finalize(i.key, "LANDED", { slot: tx!.slot, ...s, perRecipient: Object.fromEntries(Object.entries(s.perRecipient).map(([k, v]) => [k, v.toString()])), distributed: s.distributed.toString() }); out.push({ mint: i.mint, result: "LANDED" }); continue; }
    if (s.state === "MISMATCH" && tx) { await d.store.finalize(i.key, "FAILED", { code: s.code, slot: tx.slot }); out.push({ mint: i.mint, result: `FAILED:${s.code}` }); continue; }
    // Unknown: expire only once provably past the blockhash's validity at finalized height.
    if (!tx && height !== null && i.lastValidBlockHeight !== undefined && height > i.lastValidBlockHeight) { await d.store.finalize(i.key, "EXPIRED", { height }); out.push({ mint: i.mint, result: "EXPIRED" }); continue; }
    // Restart recovery: re-verify recipients before re-sending; a mismatch holds the identical bytes unsent.
    if (d.send && i.signedBase64) {
      const rv = c ? await recipientsOk(d, c) : { ok: false as const, code: "CHILD_UNKNOWN" };
      if (!rv.ok) { out.push({ mint: i.mint, result: `HELD:${rv.code}` }); continue; }
      await d.send(i.signedBase64).catch(() => {}); // resend identical bytes only
    }
    out.push({ mint: i.mint, result: d.send ? "RESENT_SAME_BYTES" : "SIGNED_HELD" });
  }
  return out;
}

export async function runChildFeePass(d: KeeperDeps): Promise<ChildOutcome[]> {
  const out = await reconcileChildren(d);
  if (d.dailyGasLamports === null) return [...out, { mint: "*", result: "SKIP:GAS_BUDGET_NOT_CONFIGURED" }];
  let children: ChildRecord[];
  try { children = await d.children(); } catch { return [...out, { mint: "*", result: "SKIP:DISCOVERY_UNAVAILABLE" }]; }
  const open = new Set((await d.store.open()).map((i) => i.mint));
  for (const c of children) {
    if (open.has(c.mint)) { out.push({ mint: c.mint, result: "SKIP:OPEN_INTENT" }); continue; }
    const v = await recipientsOk(d, c);
    if (!v.ok) { out.push({ mint: c.mint, result: `HELD:${v.code}` }); continue; }
    const onchain = v.onchain!;
    const b = await d.balances(c).catch(() => ({ curveVaultQuote: null, ammVaultQuote: null }));
    const cost = await d.estimateCost(c);
    const remaining = d.dailyGasLamports - (await d.store.gasSpentToday());
    const p = planChild({ graduated: onchain.graduated as boolean, ...b, minDistributable: d.minDistributable, estCostLamports: cost, gasRemainingLamports: remaining });
    if (p.action === "SKIP") { out.push({ mint: c.mint, result: `SKIP:${p.code}` }); continue; }
    const key = childIntentKey(c.mint, d.now());
    if ((await d.store.reserve({ key, mint: c.mint, costLamports: cost })) === "DUPLICATE") { out.push({ mint: c.mint, result: "DUPLICATE" }); continue; }
    const s = await d.buildAndSign(c, p.action);
    await d.store.recordSigned(key, s.signature, s.signedBase64, s.lastValidBlockHeight); // bytes persisted before any send
    if (d.send) await d.send(s.signedBase64).catch(() => {});
    out.push({ mint: c.mint, result: d.send ? `SENT:${p.action}` : `SIGNED_HELD:${p.action}` });
  }
  return out;
}
