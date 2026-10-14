// prepare/inspect logic with injectable chain deps. Never signs, submits or stores candidates.
import { randomUUID } from "node:crypto";
import { web3, pumpProgram, feeProgram, PROGRAMS, SDK_VERSIONS, instructionName } from "./sdk.mjs";
import { FEE_SPLIT_BPS } from "./config.mjs";
import { assessParent } from "./parent.mjs";
import { assemble, compile, manifest, feeFirst, verifyAlt, BuildError, PACKET_LIMIT } from "./build.mjs";
import { verifyCreated, verifySimulationEvents } from "./launch-state.mjs";
import { pump, BN } from "./sdk.mjs";
import { BINDING_SCHEMA, CANDIDATE_TTL_MS, macBinding, verifyBindingMac, sha256hex, canonical } from "./binding.mjs";

const { PublicKey, VersionedMessage } = web3;
const CANDIDATE_FOR = { null: "B", buy_v2: "C", buy_v3: "D", buy_exact_quote_in_v3: "E" };
const BUY_NAME = { C: "buy_v2", D: "buy_v3", E: "buy_exact_quote_in_v3" };
const ALLOWED_PROGRAMS = new Set(Object.values(PROGRAMS).map((p) => p.toBase58()));
const READ_DEADLINE_MS = 8000;

const deadline = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("deadline")), ms))]);
const blocked = (reasons, extra = {}) => ({ http: 200, body: { status: "BLOCKED", reasons, launchReady: false, ...extra } });

export function createService({ cfg, deps, now = () => Date.now() }) {
  const idem = new Map(); // idempotencyKey -> { hash, result, exp } (single-instance; documented)

  const baseEvidence = (format) => ({
    sdk: SDK_VERSIONS, programs: Object.fromEntries(["pump", "pumpFees", "pumpAmm"].map((k) => [k, PROGRAMS[k].toBase58()])),
    parentSource: deps.source, format, packetLimitBytes: PACKET_LIMIT,
    compute: "COMPUTE_NOT_MEASURED", simulation: "SIMULATION_NOT_RUN", chainAcceptance: "BLOCKED", rent: "NOT_MEASURED",
  });

  async function prepareInner(req) {
    if (cfg.state !== "READY_FOR_PREPARE") return { http: 503, body: { status: "ERROR", code: "NOT_CONFIGURED" } };
    if (!cfg.quoteMint) return blocked(["QUOTE_MINT_MISSING"]);
    if (req.creator === cfg.opsRecipient || req.creator === cfg.platformRecipient) return blocked(["FEE_RECIPIENT_DUPLICATE"]);
    // Locked 04-B decision: the optional buy is a separate, later transaction. Refused, never stripped.
    if (req.initialBuy) return blocked(["INITIAL_BUY_MUST_BE_SEPARATE"]);
    if (req.format === "v0_alt" && !cfg.lookupTable) return blocked(["ALT_NOT_CONFIGURED"]);
    const candidate = CANDIDATE_FOR[req.initialBuy ? req.initialBuy.mode : "null"];
    const evidence = { ...baseEvidence(req.format), candidate };

    let global, feeConfig, qtp, pumpQuote, bh, slot, alt = null;
    try {
      [global, feeConfig, qtp, bh, slot] = await deadline(Promise.all([
        deps.getGlobal(), deps.getFeeConfig(), deps.getQuoteTokenProgram(cfg.quoteMint), deps.getLatestBlockhash(), deps.getSlot(),
      ]), READ_DEADLINE_MS);
      pumpQuote = await deadline(deps.getPumpQuote(cfg.quoteMint, global), READ_DEADLINE_MS);
      if (req.format === "v0_alt") alt = await deadline(deps.getLookupTable(cfg.lookupTable), READ_DEADLINE_MS);
    } catch { return { http: 503, body: { status: "ERROR", code: "RPC_UNAVAILABLE", launchReady: false } }; }

    const parent = assessParent({ global, quoteMint: cfg.quoteMint, quoteTokenProgram: qtp, pumpQuote });
    if (!parent.ok) return blocked([parent.code], { evidence });
    evidence.parentScenario = parent.scenario; evidence.parentSlot = slot;
    if (req.format === "v0_alt") {
      const a = verifyAlt(alt, slot, []);
      if (!a.ok) return blocked([a.code], { evidence: { ...evidence, alt: a.detail } });
    }

    let built;
    try {
      built = await assemble({ candidate, ...req, quoteMint: cfg.quoteMint, quoteTokenProgram: qtp,
        opsRecipient: cfg.opsRecipient, platformRecipient: cfg.platformRecipient, global, feeConfig, parent });
    } catch (e) {
      if (e instanceof BuildError) return blocked([e.code], { evidence: { ...evidence, detail: e.detail } }); // never downgraded to create-only
      throw e;
    }
    if (!feeFirst(built.instructions)) return blocked(["FEE_SHARING_UNVERIFIED"], { evidence });
    const c = compile(built.instructions, new PublicKey(req.creator), bh.blockhash, req.format === "legacy" ? "legacy" : "v0", alt ? [alt] : []);
    Object.assign(evidence, {
      instructions: manifest(built.instructions), signers: c.signers, staticAccounts: c.staticAccounts, lookedUpAccounts: c.lookedUpAccounts ?? 0,
      serializedBytes: c.size, headroomBytes: PACKET_LIMIT - c.size, buyTokens: built.buyTokens ?? null,
      feeShares: built.shares.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps })),
    });
    if (c.size > PACKET_LIMIT || !c.messageBytes) return blocked(["TX_TOO_LARGE"], { evidence });

    // Real read-only simulation when the deps support it (chain mode always does). Fee configuration is
    // only "verified" when the program's own events show creator=10000 → exact 60/25/15.
    let feeConfigVerified = false;
    if (deps.simulate) {
      let sim;
      try { sim = await deadline(deps.simulate(c.messageBytes), READ_DEADLINE_MS); }
      catch { return { http: 503, body: { status: "ERROR", code: "RPC_UNAVAILABLE", launchReady: false } }; }
      evidence.simulation = { status: sim.err ? "FAIL" : "PASS", unitsConsumed: sim.unitsConsumed, slot: sim.slot, sigVerify: false };
      evidence.compute = sim.unitsConsumed != null ? { measuredUnits: sim.unitsConsumed } : "COMPUTE_NOT_MEASURED";
      if (sim.err) return blocked(["SIMULATION_FAILED"], { evidence: { ...evidence, simulationError: sim.err, logsTail: sim.logs.slice(-8) } });
      const evErr = verifySimulationEvents(sim.logs, { mint: req.mint, creator: req.creator, cfg });
      if (evErr) return blocked([evErr], { evidence });
      feeConfigVerified = true;
      evidence.chainAcceptance = "SIMULATED_NOT_SENT";
    }
    evidence.feeConfigVerified = feeConfigVerified;

    const preparationId = randomUUID();
    const binding = {
      schema: BINDING_SCHEMA, preparationId, candidate, format: req.format, creator: req.creator, mint: req.mint,
      name: req.name, symbol: req.symbol, uri: req.uri, initialBuy: req.initialBuy,
      quoteMint: cfg.quoteMint, quoteTokenProgram: qtp.toBase58(), lookupTable: alt ? cfg.lookupTable : null,
      shareholders: evidence.feeShares, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight,
      parentSlot: slot, parentScenario: parent.scenario, parentSource: deps.source,
      messageSha256: sha256hex(c.messageBytes), expiresAt: new Date(now() + CANDIDATE_TTL_MS).toISOString(),
    };
    return { http: 200, body: {
      status: "UNSIGNED_CANDIDATE", launchReady: false, preparationId, feeConfigVerified,
      recovery: "If the outcome is unknown, call /status with this same mint; never re-prepare with a new mint until status is NOT_FOUND after lastValidBlockHeight passes.",
      messageBase64: c.messageBytes.toString("base64"), binding, bindingMac: macBinding(cfg.secret, binding), evidence,
    } };
  }

  async function prepare(req) {
    const hash = sha256hex(canonical(req));
    const hit = idem.get(req.idempotencyKey);
    const t = now();
    for (const [k, v] of idem) if (v.exp < t) idem.delete(k);
    if (hit) return hit.hash === hash ? hit.result : { http: 409, body: { status: "ERROR", code: "IDEMPOTENCY_CONFLICT" } };
    const result = await prepareInner(req);
    if (result.http === 200) idem.set(req.idempotencyKey, { hash, result, exp: t + CANDIDATE_TTL_MS });
    return result;
  }

  async function inspect(body) {
    const fail = (code, extra = {}) => ({ http: 200, body: { valid: false, code, ...extra } });
    const b = body.binding;
    if (!verifyBindingMac(cfg.secret, b, body.bindingMac)) return fail("INTEGRITY_FAILED");
    if (b.schema !== BINDING_SCHEMA) return fail("INTEGRITY_FAILED");
    if (!(Date.parse(b.expiresAt) > now())) return fail("CANDIDATE_EXPIRED");
    const bytes = Buffer.from(body.messageBase64, "base64");
    if (sha256hex(bytes) !== b.messageSha256) return fail("MESSAGE_MISMATCH");
    // Server config may have changed since prepare: the bound split must still match today's fixed recipients.
    const expectShares = [[b.creator, FEE_SPLIT_BPS.creator], [cfg.opsRecipient, FEE_SPLIT_BPS.ops], [cfg.platformRecipient, FEE_SPLIT_BPS.platform]];
    if (b.quoteMint !== cfg.quoteMint || canonical(b.shareholders) !== canonical(expectShares.map(([address, bps]) => ({ address, bps })))) return fail("CONFIG_CHANGED");

    let msg, keys;
    try {
      msg = VersionedMessage.deserialize(bytes);
      const lookups = msg.addressTableLookups ?? [];
      let alts = [];
      if (lookups.length) {
        if (!b.lookupTable || lookups.length !== 1 || lookups[0].accountKey.toBase58() !== b.lookupTable) return fail("ALT_INVALID");
        alts = [await deadline(deps.getLookupTable(b.lookupTable), READ_DEADLINE_MS)];
        if (!alts[0]) return fail("ALT_INVALID");
      }
      keys = msg.getAccountKeys({ addressLookupTableAccounts: alts });
    } catch { return fail("UNSUPPORTED_FORMAT"); }

    const ixs = msg.compiledInstructions.map((ci) => ({
      programId: keys.get(ci.programIdIndex), data: Buffer.from(ci.data), keys: ci.accountKeyIndexes.map((i) => ({ pubkey: keys.get(i) })),
    }));
    const names = ixs.map(instructionName);
    const n = msg.header.numRequiredSignatures;
    const signers = msg.staticAccountKeys.slice(0, n).map((k) => k.toBase58()).sort();
    const checks = {
      payerIsCreator: msg.staticAccountKeys[0].toBase58() === b.creator,
      signersExactlyCreatorAndMint: canonical(signers) === canonical([b.creator, b.mint].sort()),
      blockhashBound: msg.recentBlockhash === b.blockhash,
      programsAllowlisted: ixs.every((ix) => ALLOWED_PROGRAMS.has(ix.programId.toBase58())),
      feeFirstOrder: feeFirst(ixs),
      createV2Bound: false, feeSharesExact: false, creatorVaultAtaExact: false, buyMatchesBinding: false,
      quoteMintReferenced: ixs.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === b.quoteMint)),
    };
    try {
      const cr = pumpProgram.coder.instruction.decode(ixs[0].data);
      checks.createV2Bound = names[0] === "create_v2" && cr.data.name === b.name && cr.data.symbol === b.symbol && cr.data.uri === b.uri
        && cr.data.creator.toBase58() === b.creator && ixs[0].keys.some((k) => k.pubkey.toBase58() === b.mint);
      const ui = names.indexOf("update_fee_shares_v2");
      // The ATA directly before the fee update must be the sharing-config creator vault's quote ATA.
      const vault = pump.creatorVaultPda(pump.feeSharingConfigPda(new web3.PublicKey(b.mint))).toBase58();
      const va = ixs[ui - 1];
      checks.creatorVaultAtaExact = names[ui - 1] === "ata_create_idempotent" && va.keys[0].pubkey.toBase58() === b.creator
        && va.keys[2].pubkey.toBase58() === vault && va.keys[3].pubkey.toBase58() === b.quoteMint;
      const up = feeProgram.coder.instruction.decode(ixs[ui].data);
      checks.feeSharesExact = canonical(up.data.shareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }))) === canonical(b.shareholders);
      const buys = names.filter((x) => x.startsWith("buy"));
      if (!b.initialBuy) checks.buyMatchesBinding = buys.length === 0;
      else {
        const want = BUY_NAME[b.candidate];
        const bi = names.indexOf(want);
        const bd = bi >= 0 ? pumpProgram.coder.instruction.decode(ixs[bi].data) : null;
        const cap = bd && (bd.data.maxSolCost ?? bd.data.maxQuoteAmountIn ?? bd.data.spendableQuoteIn ?? bd.data.spendableSolIn);
        checks.buyMatchesBinding = buys.length === 1 && bi >= 0 && cap != null && BigInt(cap.toString()) >= BigInt(b.initialBuy.quoteAmount);
      }
    } catch { /* leaves the decoded checks false */ }
    const valid = Object.values(checks).every(Boolean);
    const sigLen = n < 0x80 ? 1 : 2;
    return { http: 200, body: { valid, code: valid ? "CANDIDATE_CONSISTENT" : "CANDIDATE_INCONSISTENT", checks, instructions: names,
      serializedBytes: sigLen + 64 * n + bytes.length, simulation: "SIMULATION_NOT_RUN", chainAcceptance: "BLOCKED", launchReady: false } };
  }

  async function status(req) {
    if (cfg.state !== "READY_FOR_PREPARE" || !cfg.quoteMint) return { http: 200, body: { state: "UNKNOWN", code: cfg.quoteMint ? "NOT_CONFIGURED" : "QUOTE_MINT_MISSING" } };
    let st;
    try { st = await deadline(deps.getMintState(req.mint), READ_DEADLINE_MS); }
    catch { return { http: 503, body: { state: "UNKNOWN", code: "RPC_UNAVAILABLE" } }; } // outage is never "not found"
    return { http: 200, body: verifyCreated(st, { mint: req.mint, creator: req.creator, cfg }) };
  }

  /** Separate buy: built only against a creation whose final 60/25/15 config is verified on chain. */
  async function prepareBuy(req) {
    if (cfg.state !== "READY_FOR_PREPARE") return { http: 503, body: { status: "ERROR", code: "NOT_CONFIGURED" } };
    if (!cfg.quoteMint) return blocked(["QUOTE_MINT_MISSING"]);
    const hash = sha256hex(canonical(req));
    const hit = idem.get(req.idempotencyKey);
    if (hit) return hit.hash === hash ? hit.result : { http: 409, body: { status: "ERROR", code: "IDEMPOTENCY_CONFLICT" } };
    let st, global, feeConfig, bh;
    try {
      [st, global, feeConfig, bh] = await deadline(Promise.all([deps.getMintState(req.mint), deps.getGlobal(), deps.getFeeConfig(), deps.getLatestBlockhash()]), READ_DEADLINE_MS);
    } catch { return { http: 503, body: { status: "ERROR", code: "RPC_UNAVAILABLE", launchReady: false } }; }
    const v = verifyCreated(st, { mint: req.mint, creator: req.creator, cfg });
    if (v.state !== "CREATED_FEE_VERIFIED") return blocked([v.code ?? "CREATION_NOT_FOUND"]);
    if (v.curveComplete) return blocked(["CURVE_COMPLETE"]);
    const mint = new PublicKey(req.mint), user = new PublicKey(req.creator), quoteAmount = new BN(req.quoteAmount);
    let ixs, tokens;
    try {
      tokens = pump.getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: new BN(st.mintSupply), bondingCurve: st.bondingCurve, amount: quoteAmount, curveBaseTokenBalance: new BN(st.curveBaseTokenBalance) });
      if (tokens.isZero()) return blocked(["BUY_QUOTE_FAILED"]);
      const qtp = await deadline(deps.getQuoteTokenProgram(cfg.quoteMint), READ_DEADLINE_MS);
      const p = { bondingCurve: st.bondingCurve, associatedUserAccountInfo: null, mint, user, amount: tokens, quoteAmount, slippage: req.slippageBps / 100, tokenProgram: new PublicKey(st.mintOwner), quoteTokenProgram: qtp };
      ixs = req.mode === "buy_v3" ? await pump.PUMP_SDK.buyV3Instructions(p) : await pump.PUMP_SDK.buyExactQuoteInV3Instructions(p);
    } catch { return blocked(["BUY_NOT_BUILDABLE"]); }
    const c = compile(ixs, user, bh.blockhash, req.format);
    const evidence = { ...baseEvidence(req.format), instructions: manifest(ixs), signers: c.signers, serializedBytes: c.size, headroomBytes: PACKET_LIMIT - c.size,
      quotedTokens: tokens.toString(), priceGuaranteed: false, maxQuoteSpend: "quoteAmount plus slippage cap; actual fill may be lower" };
    if (!c.messageBytes) return blocked(["TX_TOO_LARGE"], { evidence });
    if (deps.simulate) {
      try {
        const sim = await deadline(deps.simulate(c.messageBytes), READ_DEADLINE_MS);
        evidence.simulation = { status: sim.err ? "FAIL" : "PASS", unitsConsumed: sim.unitsConsumed, slot: sim.slot, sigVerify: false };
        if (sim.err) return blocked(["SIMULATION_FAILED"], { evidence: { ...evidence, simulationError: sim.err } });
      } catch { return { http: 503, body: { status: "ERROR", code: "RPC_UNAVAILABLE" } }; }
    }
    const result = { http: 200, body: { status: "UNSIGNED_BUY_CANDIDATE", requiresExplicitUserApproval: true, launchReady: false,
      messageBase64: c.messageBytes.toString("base64"), lastValidBlockHeight: bh.lastValidBlockHeight, evidence } };
    idem.set(req.idempotencyKey, { hash, result, exp: now() + CANDIDATE_TTL_MS });
    return result;
  }

  return { prepare, inspect, status, prepareBuy };
}
