// SOL rehearsal gating. Fixtures only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures.mjs";
import { instructionName, spl } from "../src/sdk.mjs";
import { loadConfig } from "../src/config.mjs";
import { validatePrepare, validateStatus } from "../src/contract.mjs";
import { assemble } from "../src/build.mjs";
import { quoteScope, NATIVE_SOL } from "../src/service.mjs";

const pk = () => F.kp().publicKey.toBase58();
const BASE = { MCPX_TX_BUILDER_SECRET: "s".repeat(48), SOLANA_RPC_URL: "https://rpc.invalid", MCPX_FEE_OPS_RECIPIENT: F.FIXTURE_OPS, MCPX_FEE_PLATFORM_RECIPIENT: F.FIXTURE_PLATFORM, MCPX_NATIVE_DEPLOYER_PUBLIC_KEY: pk() };

test("rehearsal is off unless the creator is configured", () => {
  const cfg = loadConfig(BASE);
  assert.equal(cfg.solRehearsalCreator, null);
  assert.equal(quoteScope(cfg, true, pk()).code, "SOL_REHEARSAL_NOT_ENABLED");
});

test("only the configured creator gets the SOL quote; others are refused", () => {
  const who = pk();
  const cfg = loadConfig({ ...BASE, MCPX_SOL_REHEARSAL_CREATOR: who });
  assert.equal(quoteScope(cfg, true, pk()).code, "SOL_REHEARSAL_CREATOR_NOT_PERMITTED");
  const ok = quoteScope(cfg, true, who);
  assert.equal(ok.cfg.quoteMint, NATIVE_SOL);
  assert.equal(cfg.quoteMint, null, "base config is untouched");
});

test("the $MCP path never sees SOL, even with the rehearsal configured", () => {
  const who = pk();
  const cfg = loadConfig({ ...BASE, MCPX_SOL_REHEARSAL_CREATOR: who });
  assert.equal(quoteScope(cfg, false, who).cfg.quoteMint, null);
});

test("deployer or fee recipients can't be the rehearsal creator", () => {
  for (const w of [BASE.MCPX_NATIVE_DEPLOYER_PUBLIC_KEY, F.FIXTURE_OPS, F.FIXTURE_PLATFORM]) {
    const cfg = loadConfig({ ...BASE, MCPX_SOL_REHEARSAL_CREATOR: w });
    assert.ok(cfg.invalid.includes("MCPX_SOL_REHEARSAL_CREATOR")); assert.equal(cfg.solRehearsalCreator, null);
  }
});

test("request contract: rehearsal may only be the literal SOL", () => {
  const b = { schema: "mcpx.launch.prepare.v1", idempotencyKey: "0b0e8f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b", creator: pk(), mint: pk(), name: "X", symbol: "X", uri: "https://mcpx.fun/x.json", initialBuy: null, format: "v0_alt" };
  assert.equal(validatePrepare(b).ok, true);
  assert.equal(validatePrepare({ ...b, rehearsal: "SOL" }).ok, true);
  assert.equal(validatePrepare({ ...b, rehearsal: "USDC" }).ok, false);
  assert.equal(validateStatus({ schema: "mcpx.launch.status.v1", creator: pk(), mint: pk(), rehearsal: true }).ok, false);
});

test("native SOL candidate: create_v2 → config → update shares, no quote token account", async () => {
  const { instructions, shares } = await assemble({ candidate: "B", creator: pk(), mint: pk(), name: "R", symbol: "R", uri: "https://mcpx.fun/r.json", initialBuy: null,
    quoteMint: NATIVE_SOL, quoteTokenProgram: spl.TOKEN_PROGRAM_ID, opsRecipient: F.FIXTURE_OPS, platformRecipient: F.FIXTURE_PLATFORM,
    global: F.global, feeConfig: F.feeConfig, parent: { accounts: null, curve: null } });
  assert.deepEqual(instructions.map(instructionName), ["create_v2", "create_fee_sharing_config", "update_fee_shares_v2"]);
  assert.deepEqual(shares.map((s) => s.shareBps), [6000, 2500, 1500]);
});
