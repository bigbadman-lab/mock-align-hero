// Phase 04-A tests. Everything here is an ISOLATED FIXTURE: synthetic keys, synthetic parent curves,
// read-only mainnet Global/FeeConfig snapshot. No network, no signing of real transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as F from "./fixtures.mjs";
import { web3, pump, instructionName, programIdsPinned } from "../src/sdk.mjs";
import { loadConfig, FEE_SPLIT_BPS } from "../src/config.mjs";
import { validatePrepare } from "../src/contract.mjs";
import { assessParent } from "../src/parent.mjs";
import { assemble, compile, feeFirst, launchIndependentAccounts, verifyAlt, shareholdersFor, BuildError, PACKET_LIMIT } from "../src/build.mjs";
import { createApp, readyReport } from "../src/server.mjs";
import { signRequest, SCOPES } from "../src/auth.mjs";
import { macBinding } from "../src/binding.mjs";

const SECRET = "s".repeat(48);
const QUOTE = F.FIXTURE_QUOTE.toBase58();
const ENV = { MCPX_TX_BUILDER_SECRET: SECRET, SOLANA_RPC_URL: "https://rpc.invalid", MCPX_FEE_OPS_RECIPIENT: F.FIXTURE_OPS, MCPX_FEE_PLATFORM_RECIPIENT: F.FIXTURE_PLATFORM, MCPX_QUOTE_MINT: QUOTE, MCPX_LOOKUP_TABLE: F.kp().publicKey.toBase58(), MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: F.kp().publicKey.toBase58() };
const parentOk = () => assessParent({ global: F.global, quoteMint: QUOTE, quoteTokenProgram: F.SPL, pumpQuote: F.parentFixture("active") });
const MODE = { C: "buy_v2", D: "buy_v3", E: "buy_exact_quote_in_v3", F: "buy_v3" };
const build = (cand, o = {}) => assemble({
  candidate: cand, creator: o.creator ?? F.kp().publicKey.toBase58(), mint: o.mint ?? F.kp().publicKey.toBase58(),
  name: o.name ?? "Fixture Tool Coin", symbol: o.symbol ?? "FIXT", uri: o.uri ?? "https://mcpx.fun/meta/fixture.json",
  initialBuy: MODE[cand] ? { mode: MODE[cand], quoteAmount: "1000000000", slippageBps: 100 } : null,
  quoteMint: QUOTE, quoteTokenProgram: o.qtp ?? F.SPL, opsRecipient: F.FIXTURE_OPS, platformRecipient: F.FIXTURE_PLATFORM,
  global: F.global, feeConfig: F.feeConfig, parent: o.parent ?? parentOk(),
});

async function fixtureAlt() {
  const [x, y] = [await build("F"), await build("F")];
  const addrs = launchIndependentAccounts(x.instructions, y.instructions).map((a) => new web3.PublicKey(a));
  return new web3.AddressLookupTableAccount({ key: new web3.PublicKey(ENV.MCPX_LOOKUP_TABLE), state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 10, lastExtendedSlotStartIndex: 0, addresses: addrs } });
}
async function fixtureDeps(over = {}) {
  const alt = await fixtureAlt();
  return {
    source: "fixture", getGlobal: async () => F.global, getFeeConfig: async () => F.feeConfig,
    getQuoteTokenProgram: async () => F.SPL, getPumpQuote: async () => F.parentFixture("active"),
    getLatestBlockhash: async () => ({ blockhash: F.FIXTURE_BLOCKHASH, lastValidBlockHeight: 1000 }),
    getSlot: async () => 500, getLookupTable: async () => alt, ...over,
  };
}

// Minimal in-process HTTP harness (no sockets).
async function call(app, { method = "POST", path, body = "", headers = {}, sign = true, scope, ts = Date.now(), nonce = randomUUID() }) {
  const h = { "content-type": "application/json", ...headers };
  if (sign) Object.assign(h, { "x-mcpx-timestamp": String(ts), "x-mcpx-nonce": nonce, "x-mcpx-scope": scope ?? SCOPES[path],
    "x-mcpx-signature": signRequest(SECRET, { ts: String(ts), nonce, scope: scope ?? SCOPES[path], method, path, body }) });
  const req = { method, url: path, headers: h, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, writeHead(s, hd) { this.status = s; this.headers = hd; }, end(b) { resolve({ status: this.status, headers: this.headers, json: b ? JSON.parse(b) : null }); } };
    app(req, res);
  });
}
const prepBody = (o = {}) => JSON.stringify({ schema: "mcpx.launch.prepare.v1", idempotencyKey: randomUUID(), creator: F.kp().publicKey.toBase58(), mint: F.kp().publicKey.toBase58(),
  name: "Fixture Tool Coin", symbol: "FIXT", uri: "https://mcpx.fun/meta/fixture.json", initialBuy: null, format: "v0_alt", ...o });

test("S01 /health and /ready distinguish config, SDK, quote and recipients", async () => {
  const none = loadConfig({});
  assert.equal(none.state, "NOT_CONFIGURED");
  const r0 = readyReport(none);
  assert.equal(r0.ready, false); assert.equal(r0.quoteMint, "QUOTE_MINT_MISSING"); assert.equal(r0.feeRecipients, "MISSING"); assert.equal(r0.launchEnabled, false);
  const noQuote = loadConfig({ ...ENV, MCPX_QUOTE_MINT: "" });
  assert.equal(noQuote.state, "READY_FOR_PREPARE"); assert.equal(readyReport(noQuote).quoteMint, "QUOTE_MINT_MISSING");
  assert.equal(programIdsPinned(), true);
  const app = createApp({ cfg: noQuote, deps: await fixtureDeps() });
  assert.equal((await call(app, { method: "GET", path: "/health", sign: false })).json.ok, true);
  const rd = (await call(app, { method: "GET", path: "/ready", sign: false })).json;
  assert.equal(rd.ready, true); assert.deepEqual(rd.feeSplitBps, { creator: 6000, ops: 2500, platform: 1500 });
  assert.ok(!JSON.stringify(rd).includes(F.FIXTURE_OPS), "recipient addresses are not published");
});

test("S02 HMAC: invalid, expired, replayed, wrong scope and body tampering rejected before work", async () => {
  let reads = 0;
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps({ getGlobal: async () => { reads++; return F.global; } }) });
  const path = "/internal/v1/launch/prepare", body = prepBody();
  assert.equal((await call(app, { path, body, sign: false })).status, 401);
  assert.equal((await call(app, { path, body, ts: Date.now() - 10 * 60_000 })).status, 401);
  assert.equal((await call(app, { path, body, scope: "launch.inspect" })).status, 401);
  const nonce = randomUUID(), ts = Date.now();
  const sig = signRequest(SECRET, { ts: String(ts), nonce, scope: "launch.prepare", method: "POST", path, body });
  const tampered = { "x-mcpx-timestamp": String(ts), "x-mcpx-nonce": nonce, "x-mcpx-scope": "launch.prepare", "x-mcpx-signature": sig };
  assert.equal((await call(app, { path, body: body.replace("FIXT", "EVIL"), sign: false, headers: tampered })).status, 401);
  assert.equal((await call(app, { path, body, nonce, ts })).status, 200);
  assert.equal((await call(app, { path, body, nonce, ts })).status, 401, "replay");
  assert.equal(reads, 1, "only the one authenticated request reached chain reads");
});

test("S03 methods, size, malformed JSON, extra fields and rogue overrides refused", async () => {
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps() });
  assert.equal((await call(app, { method: "GET", path: "/internal/v1/launch/prepare", sign: false })).status, 405);
  assert.equal((await call(app, { method: "PUT", path: "/health", sign: false })).headers.allow, "GET");
  assert.equal((await call(app, { method: "POST", path: "/internal/v1/launch/submit", sign: false })).status, 404);
  assert.equal((await call(app, { method: "POST", path: "/sign", sign: false })).status, 404);
  assert.equal((await call(app, { path: "/internal/v1/launch/prepare", body: "x".repeat(17 * 1024) })).status, 413);
  assert.equal((await call(app, { path: "/internal/v1/launch/prepare", body: "{not json" })).status, 400);
  for (const extra of [{ rpcUrl: "https://evil" }, { programId: pump.PUMP_PROGRAM_ID.toBase58() }, { feeRecipients: [F.FIXTURE_OPS] }, { shareBps: [10000] }, { lookupTable: ENV.MCPX_LOOKUP_TABLE }]) {
    const r = await call(app, { path: "/internal/v1/launch/prepare", body: JSON.stringify({ ...JSON.parse(prepBody()), ...extra }) });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal(validatePrepare({ ...JSON.parse(prepBody()), initialBuy: { mode: "buy_v3", quoteAmount: "1", slippageBps: 5000 } }).ok, false);
});

test("S04 not configured and RPC outage fail closed, never as empty success", async () => {
  const off = createApp({ cfg: loadConfig({}), deps: { source: "chain" } });
  const o = await call(off, { path: "/internal/v1/launch/prepare", body: prepBody(), sign: false });
  assert.equal(o.status, 503); assert.equal(o.json.error, "NOT_CONFIGURED");
  const down = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps({ getGlobal: async () => { throw new Error("rpc down"); } }) });
  const r = await call(down, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.equal(r.status, 503); assert.equal(r.json.code, "RPC_UNAVAILABLE"); assert.equal(r.json.launchReady, false);
  const noMint = createApp({ cfg: loadConfig({ ...ENV, MCPX_QUOTE_MINT: "" }), deps: await fixtureDeps() });
  const q = await call(noMint, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.equal(q.json.status, "BLOCKED"); assert.deepEqual(q.json.reasons, ["QUOTE_MINT_MISSING"]); assert.equal(q.json.messageBase64, undefined);
});

test("T01 official SDK create_v2 for a pump-coin quote", async () => {
  const creator = F.kp().publicKey, mint = F.kp().publicKey;
  const { instructions } = await build("A", { creator: creator.toBase58(), mint: mint.toBase58() });
  assert.equal(instructionName(instructions[0]), "create_v2");
  assert.equal(instructions[0].programId.toBase58(), "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const keys = instructions[0].keys.map((k) => k.pubkey.toBase58());
  assert.ok(keys.includes(mint.toBase58()) && keys.includes(QUOTE) && keys.includes(pump.bondingCurvePda(QUOTE).toBase58()), "mint, quote and parent curve accounts present");
  assert.ok(instructions[0].keys.find((k) => k.pubkey.equals(mint)).isSigner);
});

test("T02 exact 60/25/15 with fixed distinct recipients", async () => {
  const c = F.kp().publicKey.toBase58();
  const s = shareholdersFor(c, F.FIXTURE_OPS, F.FIXTURE_PLATFORM);
  assert.deepEqual(s.map((x) => x.shareBps), [6000, 2500, 1500]);
  assert.equal(FEE_SPLIT_BPS.creator + FEE_SPLIT_BPS.ops + FEE_SPLIT_BPS.platform, 10000);
  assert.throws(() => shareholdersFor(F.FIXTURE_OPS, F.FIXTURE_OPS, F.FIXTURE_PLATFORM), (e) => e.code === "FEE_RECIPIENT_DUPLICATE");
  assert.equal(loadConfig({ ...ENV, MCPX_FEE_PLATFORM_RECIPIENT: F.FIXTURE_OPS }).state, "NOT_CONFIGURED");
  await assert.rejects(pump.PUMP_SDK.updateFeeSharesV2({ authority: F.kp().publicKey, mint: F.kp().publicKey, currentShareholders: [], newShareholders: [{ address: F.kp().publicKey, shareBps: 9999 }], quoteMint: F.FIXTURE_QUOTE, quoteTokenProgram: F.SPL }));
});

test("T03 fee-secured B: exact order and signers", async () => {
  const creator = F.kp().publicKey, mint = F.kp().publicKey;
  const { instructions } = await build("B", { creator: creator.toBase58(), mint: mint.toBase58() });
  assert.deepEqual(instructions.map(instructionName), ["create_v2", "create_fee_sharing_config", "ata_create_idempotent", "update_fee_shares_v2"]);
  assert.ok(feeFirst(instructions));
  // CHILD-FEES-01: the pre-created ATA is exactly the sharing-config creator vault's quote ATA, paid by the creator.
  const vault = pump.creatorVaultPda(pump.feeSharingConfigPda(mint));
  const ata = instructions[2];
  assert.equal(ata.keys[0].pubkey.toBase58(), creator.toBase58());
  assert.equal(ata.keys[2].pubkey.toBase58(), vault.toBase58());
  assert.equal(ata.keys[3].pubkey.toBase58(), F.FIXTURE_QUOTE.toBase58());
  const c = compile(instructions, creator, F.FIXTURE_BLOCKHASH, "v0");
  assert.deepEqual(new Set(c.signers), new Set([creator.toBase58(), mint.toBase58()]));
});

test("T04 C/D/E/F assembly and exact serialized sizes (fixture signatures)", async () => {
  const alt = await fixtureAlt();
  for (const cand of ["C", "D", "E", "F"]) {
    const creator = F.kp(), mint = F.kp();
    const { instructions } = await build(cand, { creator: creator.publicKey.toBase58(), mint: mint.publicKey.toBase58() });
    assert.ok(feeFirst(instructions), cand);
    assert.ok(instructions.some((ix) => instructionName(ix) === MODE[cand]), cand);
    const c = compile(instructions, creator.publicKey, F.FIXTURE_BLOCKHASH, "v0", [alt]);
    if (c.size <= PACKET_LIMIT) {
      const tx = new web3.VersionedTransaction(web3.VersionedMessage.deserialize(c.messageBytes));
      tx.sign([creator, mint]); // disposable fixture keys, size measurement only
      assert.equal(tx.serialize().length, c.size, `${cand} computed size equals signed wire size`);
    }
  }
});

test("T05 v0+ALT verification; v1 not supported by pinned web3.js", async () => {
  const alt = await fixtureAlt();
  assert.equal(verifyAlt(alt, 500, []).ok, true);
  assert.equal(verifyAlt({ state: { ...alt.state, deactivationSlot: 400n } }, 500, []).code, "ALT_INVALID");
  assert.equal(verifyAlt({ state: { ...alt.state, lastExtendedSlot: 500 } }, 500, []).detail, "not_warmed");
  assert.equal(verifyAlt(null, 500, []).ok, false);
  assert.equal(typeof web3.MessageV1, "undefined");
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps({ getLookupTable: async () => ({ state: { ...alt.state, deactivationSlot: 1n } }) }) });
  const r = await call(app, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.deepEqual(r.json.reasons, ["ALT_INVALID"]);
});

test("T06 parent scenarios: active/migrated × SPL/Token-2022 pass; awaiting, mayhem, depth, wrong quote, wrong program refused", () => {
  const a = (kind, qtp = F.SPL, quoteMint = QUOTE) => assessParent({ global: F.global, quoteMint, quoteTokenProgram: qtp, pumpQuote: F.parentFixture(kind) });
  assert.equal(a("active").scenario, "active_curve_spl");
  assert.equal(a("active", F.T22).scenario, "active_curve_token2022");
  assert.equal(a("migrated").scenario, "migrated_pool_spl");
  assert.equal(a("migrated", F.T22).scenario, "migrated_pool_token2022");
  assert.equal(a("awaiting").code, "QUOTE_AWAITING_MIGRATION");
  assert.equal(a("mayhem").code, "QUOTE_MAYHEM_PROHIBITED");
  assert.equal(a("depth1").code, "QUOTE_ALREADY_PUMP_PAIRED");
  assert.equal(a("active", F.SPL, F.kp().publicKey.toBase58()).code, "QUOTE_MINT_MISMATCH");
  assert.equal(a("active", web3.SystemProgram.programId).code, "QUOTE_TOKEN_PROGRAM_MISMATCH");
  assert.equal(assessParent({ global: F.global, quoteMint: QUOTE, quoteTokenProgram: F.SPL, pumpQuote: null }).code, "QUOTE_INELIGIBLE");
});

test("T07 any change to bound values invalidates the candidate", async () => {
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps() });
  const p = await call(app, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.equal(p.json.status, "UNSIGNED_CANDIDATE", JSON.stringify(p.json.reasons));
  const ins = (o) => call(app, { path: "/internal/v1/launch/inspect", body: JSON.stringify({ schema: "mcpx.launch.inspect.v1", messageBase64: p.json.messageBase64, binding: p.json.binding, bindingMac: p.json.bindingMac, ...o }) });
  const ok = await ins({});
  assert.equal(ok.json.valid, true, JSON.stringify(ok.json.checks));
  const other = F.kp().publicKey.toBase58();
  for (const change of [{ creator: other }, { mint: other }, { quoteMint: other }, { blockhash: other },
    { shareholders: p.json.binding.shareholders.map((s, i) => ({ ...s, bps: i === 0 ? 7000 : i === 1 ? 1500 : 1500 })) },
    { shareholders: [{ address: p.json.binding.creator, bps: 6000 }, { address: other, bps: 2500 }, p.json.binding.shareholders[2]] },
    { initialBuy: { ...p.json.binding.initialBuy, quoteAmount: "2000000000" } }, { initialBuy: { ...p.json.binding.initialBuy, slippageBps: 900 } }]) {
    assert.equal((await ins({ binding: { ...p.json.binding, ...change } })).json.code, "INTEGRITY_FAILED", JSON.stringify(Object.keys(change)));
  }
  const bytes = Buffer.from(p.json.messageBase64, "base64"); bytes[bytes.length - 1] ^= 1;
  assert.equal((await ins({ messageBase64: bytes.toString("base64") })).json.code, "MESSAGE_MISMATCH");
  // Even a correctly re-MAC'd binding fails when the message no longer matches it.
  const forged = { ...p.json.binding, name: "Other Name" };
  assert.equal((await ins({ binding: forged, bindingMac: macBinding(SECRET, forged) })).json.valid, false);
});

test("T08 a failing optional buy never downgrades to create-only", async () => {
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps() });
  const r = await call(app, { path: "/internal/v1/launch/prepare", body: prepBody({ initialBuy: { mode: "buy_v3", quoteAmount: "1000000000", slippageBps: 100 } }) });
  assert.equal(r.json.status, "BLOCKED");
  assert.deepEqual(r.json.reasons, ["INITIAL_BUY_MUST_BE_SEPARATE"], "refused explicitly, never stripped to create-only");
  assert.equal(r.json.messageBase64, undefined);
  await assert.rejects(assemble({ candidate: "D", creator: F.kp().publicKey.toBase58(), mint: F.kp().publicKey.toBase58(), name: "X", symbol: "X", uri: "https://x.y/z", initialBuy: null,
    quoteMint: QUOTE, quoteTokenProgram: F.SPL, opsRecipient: F.FIXTURE_OPS, platformRecipient: F.FIXTURE_PLATFORM, global: F.global, feeConfig: F.feeConfig, parent: parentOk() }), (e) => e instanceof BuildError && e.code === "INITIAL_BUY_REQUIRED");
});

test("T09 fixture-built candidates are labelled and never launch-ready", async () => {
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps() });
  const r = await call(app, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.equal(r.json.launchReady, false);
  assert.equal(r.json.binding.parentSource, "fixture");
  assert.equal(r.json.evidence.parentSource, "fixture");
});

test("T10 simulation not run; chain acceptance stays BLOCKED", async () => {
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps() });
  const r = await call(app, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.equal(r.json.evidence.simulation, "SIMULATION_NOT_RUN");
  assert.equal(r.json.evidence.chainAcceptance, "BLOCKED");
  assert.equal(r.json.feeConfigVerified, false);
  assert.equal(r.json.evidence.compute, "COMPUTE_NOT_MEASURED");
});

test("idempotency: same key + same body returns the same candidate; different body conflicts", async () => {
  const app = createApp({ cfg: loadConfig(ENV), deps: await fixtureDeps() });
  const body = prepBody();
  const a = await call(app, { path: "/internal/v1/launch/prepare", body });
  const b = await call(app, { path: "/internal/v1/launch/prepare", body });
  assert.equal(a.json.preparationId, b.json.preparationId);
  const changed = JSON.stringify({ ...JSON.parse(body), symbol: "OTHER" });
  assert.equal((await call(app, { path: "/internal/v1/launch/prepare", body: changed })).status, 409);
});

// ---- Phase 04-B ----
import { verifyCreated } from "../src/launch-state.mjs";
const cfgB = loadConfig(ENV);
function createdState(creator, mint, o = {}) {
  const bc = { ...pump.newBondingCurve(F.global, F.FIXTURE_QUOTE, null, undefined, false, F.parentFixture("active").curve), isMayhemMode: false,
    creator: pump.feeSharingConfigPda(new web3.PublicKey(mint)), quoteMint: F.FIXTURE_QUOTE, ...o.curve };
  const shares = o.shares ?? [[creator, 6000], [F.FIXTURE_OPS, 2500], [F.FIXTURE_PLATFORM, 1500]];
  return { mintOwner: F.T22.toBase58(), bondingCurve: bc, curveBaseTokenBalance: bc.realTokenReserves.toString(), mintSupply: F.global.tokenTotalSupply.toString(),
    sharingConfig: o.noConfig ? null : { mint: new web3.PublicKey(mint), admin: new web3.PublicKey(o.admin ?? creator), adminRevoked: false, version: 1,
      shareholders: shares.map(([a, b]) => ({ address: new web3.PublicKey(a), shareBps: b })) } };
}

test("B01 simulation failure blocks creation; missing fee events never count as verified", async () => {
  const fail = createApp({ cfg: cfgB, deps: await fixtureDeps({ simulate: async () => ({ err: { InstructionError: [2, { Custom: 6000 }] }, unitsConsumed: 1, logs: ["x"], slot: 1 }) }) });
  const r = await call(fail, { path: "/internal/v1/launch/prepare", body: prepBody() });
  assert.deepEqual(r.json.reasons, ["SIMULATION_FAILED"]); assert.equal(r.json.messageBase64, undefined);
  const noEv = createApp({ cfg: cfgB, deps: await fixtureDeps({ simulate: async () => ({ err: null, unitsConsumed: 300000, logs: [], slot: 1 }) }) });
  assert.deepEqual((await call(noEv, { path: "/internal/v1/launch/prepare", body: prepBody() })).json.reasons, ["SIMULATION_EVENTS_MISSING"]);
  const down = createApp({ cfg: cfgB, deps: await fixtureDeps({ simulate: async () => { throw new Error("rpc"); } }) });
  assert.equal((await call(down, { path: "/internal/v1/launch/prepare", body: prepBody() })).json.code, "RPC_UNAVAILABLE");
});

test("B02 creation status: not found, verified, and every mismatch", () => {
  const creator = F.kp().publicKey.toBase58(), mint = F.kp().publicKey.toBase58(), x = { mint, creator, cfg: cfgB };
  assert.equal(verifyCreated({ mintOwner: null, bondingCurve: null, sharingConfig: null }, x).state, "NOT_FOUND");
  assert.equal(verifyCreated(createdState(creator, mint), x).state, "CREATED_FEE_VERIFIED");
  assert.equal(verifyCreated(createdState(creator, mint, { shares: [[creator, 10000]] }), x).code, "FEE_SHARES_MISMATCH", "fee config never updated");
  assert.equal(verifyCreated(createdState(creator, mint, { shares: [[creator, 6000], [F.FIXTURE_OPS, 1500], [F.FIXTURE_PLATFORM, 2500]] }), x).code, "FEE_SHARES_MISMATCH");
  assert.equal(verifyCreated(createdState(creator, mint, { noConfig: true }), x).code, "SHARING_CONFIG_NOT_FOUND");
  assert.equal(verifyCreated(createdState(creator, mint, { curve: { creator: new web3.PublicKey(creator) } }), x).code, "CURVE_CREATOR_NOT_SHARING_CONFIG");
  assert.equal(verifyCreated(createdState(creator, mint, { curve: { quoteMint: F.kp().publicKey } }), x).code, "QUOTE_MINT_MISMATCH");
  assert.equal(verifyCreated(createdState(creator, mint, { admin: F.kp().publicKey.toBase58() }), x).code, "SHARING_ADMIN_MISMATCH");
});

test("B03 status endpoint: RPC outage is UNKNOWN, never NOT_FOUND", async () => {
  const app = createApp({ cfg: cfgB, deps: await fixtureDeps({ getMintState: async () => { throw new Error("down"); } }) });
  const r = await call(app, { path: "/internal/v1/launch/status", body: JSON.stringify({ schema: "mcpx.launch.status.v1", creator: F.kp().publicKey.toBase58(), mint: F.kp().publicKey.toBase58() }) });
  assert.equal(r.status, 503); assert.equal(r.json.state, "UNKNOWN");
});

const buyBody = (creator, mint, o = {}) => JSON.stringify({ schema: "mcpx.launch.prepare-buy.v1", idempotencyKey: randomUUID(), creator, mint, mode: "buy_v3", quoteAmount: "1000000000", slippageBps: 100, format: "v0", ...o });

test("B04 separate buy only after verified 60/25/15 creation; needs explicit approval; no price guarantee", async () => {
  const creator = F.kp().publicKey.toBase58(), mint = F.kp().publicKey.toBase58();
  const notYet = createApp({ cfg: cfgB, deps: await fixtureDeps({ getMintState: async () => ({ mintOwner: null, bondingCurve: null, sharingConfig: null }) }) });
  assert.deepEqual((await call(notYet, { path: "/internal/v1/launch/prepare-buy", body: buyBody(creator, mint) })).json.reasons, ["CREATION_NOT_FOUND"]);
  const unpaid = createApp({ cfg: cfgB, deps: await fixtureDeps({ getMintState: async () => createdState(creator, mint, { shares: [[creator, 10000]] }) }) });
  assert.deepEqual((await call(unpaid, { path: "/internal/v1/launch/prepare-buy", body: buyBody(creator, mint) })).json.reasons, ["FEE_SHARES_MISMATCH"]);
  const ok = createApp({ cfg: cfgB, deps: await fixtureDeps({ getMintState: async () => createdState(creator, mint) }) });
  for (const mode of ["buy_v3", "buy_exact_quote_in_v3"]) {
    const r = await call(ok, { path: "/internal/v1/launch/prepare-buy", body: buyBody(creator, mint, { mode }) });
    assert.equal(r.json.status, "UNSIGNED_BUY_CANDIDATE", JSON.stringify(r.json));
    assert.equal(r.json.requiresExplicitUserApproval, true); assert.equal(r.json.evidence.priceGuaranteed, false);
    assert.ok(r.json.evidence.instructions.some((i) => i.name === mode)); assert.deepEqual(r.json.evidence.signers, [creator]);
    assert.ok(r.json.evidence.serializedBytes <= 1232);
  }
  assert.equal((await call(ok, { path: "/internal/v1/launch/prepare-buy", body: buyBody(creator, mint, { mode: "buy_v2" }) })).status, 400);
});

test("D02 /ready: operational readiness never lifts launch blockers; nothing secret is reported", async () => {
  const full = readyReport(loadConfig(ENV));
  assert.equal(full.ready, true); assert.equal(full.launchBlocked, true); assert.equal(full.launchEnabled, false);
  assert.deepEqual(full.launchBlockers, ["FULL_FEE_FIRST_SIMULATION_NOT_VERIFIED", "METADATA_STORAGE_NOT_CONFIGURED", "SIGNING_FLOW_NOT_APPROVED"]);
  const bare = readyReport(loadConfig({ ...ENV, MCPX_QUOTE_MINT: "", MCPX_LOOKUP_TABLE: "" }));
  assert.ok(bare.launchBlockers.includes("QUOTE_MINT_MISSING") && bare.launchBlockers.includes("LOOKUP_TABLE_NOT_CONFIGURED"));
  const txt = JSON.stringify(full);
  for (const v of [SECRET, ENV.SOLANA_RPC_URL, F.FIXTURE_OPS, F.FIXTURE_PLATFORM, QUOTE, ENV.MCPX_LOOKUP_TABLE]) assert.ok(!txt.includes(v));
});

test("D03 malformed secret/RPC/recipients fail closed and are reported by name only", () => {
  const c = loadConfig({ ...ENV, MCPX_TX_BUILDER_SECRET: "short", SOLANA_RPC_URL: "http://rpc", MCPX_FEE_PLATFORM_RECIPIENT: F.FIXTURE_OPS });
  assert.equal(c.state, "NOT_CONFIGURED");
  assert.deepEqual(c.invalid.sort(), ["MCPX_FEE_RECIPIENTS_DUPLICATE", "MCPX_TX_BUILDER_SECRET", "SOLANA_RPC_URL"].sort());
  const r = readyReport(c); assert.equal(r.ready, false); assert.equal(r.feeRecipients, "MISSING");
  assert.ok(!JSON.stringify(r).includes("short"));
});

test("B01 CREATOR_RECIPIENT_BINDING: native deployer can never be the 60% creator or a fee recipient", async () => {
  const dep = F.kp().publicKey.toBase58();
  const cfg = loadConfig({ ...ENV, MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: dep });
  assert.equal(cfg.state, "READY_FOR_PREPARE");
  const app = createApp({ cfg, deps: await fixtureDeps() });
  const r = await call(app, { path: "/internal/v1/launch/prepare", body: JSON.stringify({ ...JSON.parse(prepBody()), creator: dep }) });
  assert.ok(JSON.stringify(r.body ?? r.json ?? r).includes("CREATOR_IS_NATIVE_DEPLOYER"));
  assert.equal(loadConfig({ ...ENV, MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: F.FIXTURE_OPS }).state, "NOT_CONFIGURED");
  assert.equal(loadConfig({ ...ENV, MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: F.FIXTURE_PLATFORM }).state, "NOT_CONFIGURED");
});

test("B02 CREATOR_RECIPIENT_BINDING: 60% shareholder, payer and signer are all the request's creator", async () => {
  const creator = F.kp().publicKey, mint = F.kp().publicKey;
  const { instructions, shares } = await build("B", { creator: creator.toBase58(), mint: mint.toBase58() });
  assert.deepEqual(shares.map((s) => [s.address.toBase58(), s.shareBps]), [[creator.toBase58(), 6000], [F.FIXTURE_OPS, 2500], [F.FIXTURE_PLATFORM, 1500]]);
  const c = compile(instructions, creator, F.FIXTURE_BLOCKHASH, "v0");
  assert.equal(c.signers[0], creator.toBase58());
  assert.deepEqual(new Set(c.signers), new Set([creator.toBase58(), mint.toBase58()]));
});

test("B03 production config: deployer public key required, key material and conflicts refused", () => {
  const { MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: _d, ...noDep } = ENV;
  assert.ok(loadConfig(noDep).missing.includes("MCPX_NATIVE_DEPLOYER_PUBLIC_KEY"));
  assert.equal(loadConfig(noDep).state, "NOT_CONFIGURED");
  assert.equal(loadConfig({ ...ENV, MCPX_DEPLOYER_PRIVATE_KEY: "x" }).state, "NOT_CONFIGURED");
  assert.equal(loadConfig({ ...ENV, MCPX_FEE_PLATFORM_RECIPIENT: F.FIXTURE_OPS }).state, "NOT_CONFIGURED");
  assert.equal(loadConfig({ ...ENV, MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: "not-a-key" }).state, "NOT_CONFIGURED");
  assert.equal(loadConfig(ENV).state, "READY_FOR_PREPARE");
});
