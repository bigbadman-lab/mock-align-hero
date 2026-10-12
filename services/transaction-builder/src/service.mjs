// prepare/inspect logic with injectable chain deps. Never signs, submits or stores candidates.
import { randomUUID } from "node:crypto";
import { web3, pumpProgram, feeProgram, PROGRAMS, SDK_VERSIONS, instructionName } from "./sdk.mjs";
import { FEE_SPLIT_BPS } from "./config.mjs";
import { assessParent } from "./parent.mjs";
import { assemble, compile, manifest, feeFirst, verifyAlt, BuildError, PACKET_LIMIT } from "./build.mjs";
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
      status: "UNSIGNED_CANDIDATE", launchReady: false, preparationId,
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
      createV2Bound: false, feeSharesExact: false, buyMatchesBinding: false,
      quoteMintReferenced: ixs.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === b.quoteMint)),
    };
    try {
      const cr = pumpProgram.coder.instruction.decode(ixs[0].data);
      checks.createV2Bound = names[0] === "create_v2" && cr.data.name === b.name && cr.data.symbol === b.symbol && cr.data.uri === b.uri
        && cr.data.creator.toBase58() === b.creator && ixs[0].keys.some((k) => k.pubkey.toBase58() === b.mint);
      const ui = names.indexOf("update_fee_shares_v2");
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

  return { prepare, inspect };
}
