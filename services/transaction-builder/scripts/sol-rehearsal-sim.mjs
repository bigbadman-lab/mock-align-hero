// READ-ONLY: builds the SOL rehearsal candidate through the real service and simulates it on mainnet
// (sigVerify off). Nothing is signed or sent. Usage: node scripts/sol-rehearsal-sim.mjs <RPC_URL> <CREATOR> [format]
import { randomUUID } from "node:crypto";
import { web3 } from "../src/sdk.mjs";
import { createService } from "../src/service.mjs";
import { createChainDeps } from "../src/chain.mjs";
const [rpc, creator, format = "v0"] = process.argv.slice(2);
const cfg = { state: "READY_FOR_PREPARE", secret: "x".repeat(48), quoteMint: null, lookupTable: process.env.MCPX_LOOKUP_TABLE ?? null,
  opsRecipient: process.env.MCPX_FEE_OPS_RECIPIENT, platformRecipient: process.env.MCPX_FEE_PLATFORM_RECIPIENT,
  nativeDeployer: process.env.MCPX_NATIVE_DEPLOYER_PUBLIC_KEY, solRehearsalCreator: creator };
const svc = createService({ cfg, deps: createChainDeps(rpc) });
const conn = new web3.Connection(rpc);
const bal = await conn.getBalance(new web3.PublicKey(creator));
const r = await svc.prepare({ schema: "mcpx.launch.prepare.v1", idempotencyKey: randomUUID(), creator, mint: web3.Keypair.generate().publicKey.toBase58(),
  name: "MCPX Rehearsal", symbol: "MCPXR", uri: "https://mcpx.fun/api/public/launch-assets/rehearsal.json", initialBuy: null, format, rehearsal: "SOL" });
const e = r.body.evidence ?? {};
console.log(JSON.stringify({ creatorLamports: bal, status: r.body.status, reasons: r.body.reasons, feeConfigVerified: r.body.feeConfigVerified,
  instructions: e.instructions?.map((i) => i.name), bytes: e.serializedBytes, headroom: e.headroomBytes, simulation: e.simulation, simError: e.simulationError, logs: e.logsTail, sharesLocked: e.sharesLocked, quoteMint: r.body.binding?.quoteMint, rehearsal: r.body.binding?.rehearsal }, null, 1));
