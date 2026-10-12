// Size evidence table. ISOLATED FIXTURES ONLY (synthetic keys/parent curves, mainnet Global snapshot).
import * as F from "../test/fixtures.mjs";
import { web3, instructionName, SDK_VERSIONS } from "../src/sdk.mjs";
import { assessParent } from "../src/parent.mjs";
import { assemble, compile, launchIndependentAccounts, PACKET_LIMIT } from "../src/build.mjs";

const MODE = { C: "buy_v2", D: "buy_v3", E: "buy_exact_quote_in_v3", F: "buy_v3" };
const META = { typical: ["Fixture Tool Coin", "FIXT", "https://mcpx.fun/meta/fixture.json"], worst: ["W".repeat(32), "W".repeat(10), "https://" + "w".repeat(192)] };
const rows = [];
for (const [scenario, kind, qtp] of [["active_curve_spl", "active", F.SPL], ["active_curve_token2022", "active", F.T22], ["migrated_pool_spl", "migrated", F.SPL]]) {
  const pq = F.parentFixture(kind);
  const parent = assessParent({ global: F.global, quoteMint: F.FIXTURE_QUOTE.toBase58(), quoteTokenProgram: qtp, pumpQuote: pq });
  for (const meta of ["typical", "worst"]) for (const cand of ["A", "B", "C", "D", "E", "F"]) {
    const mk = async () => { const c = F.kp(), m = F.kp(); const [name, symbol, uri] = META[meta];
      return { c, r: await assemble({ candidate: cand, creator: c.publicKey.toBase58(), mint: m.publicKey.toBase58(), name, symbol, uri,
        initialBuy: MODE[cand] ? { mode: MODE[cand], quoteAmount: "1000000000", slippageBps: 100 } : null, quoteMint: F.FIXTURE_QUOTE.toBase58(), quoteTokenProgram: qtp,
        opsRecipient: F.FIXTURE_OPS, platformRecipient: F.FIXTURE_PLATFORM, global: F.global, feeConfig: F.feeConfig, parent }) }; };
    const x = await mk(), y = await mk();
    const addrs = launchIndependentAccounts(x.r.instructions, y.r.instructions).map((a) => new web3.PublicKey(a));
    const alt = new web3.AddressLookupTableAccount({ key: F.kp().publicKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: addrs } });
    const L = compile(x.r.instructions, x.c.publicKey, F.FIXTURE_BLOCKHASH, "legacy");
    const V = compile(x.r.instructions, x.c.publicKey, F.FIXTURE_BLOCKHASH, "v0");
    const A = compile(x.r.instructions, x.c.publicKey, F.FIXTURE_BLOCKHASH, "v0", [alt]);
    rows.push({ scenario, meta, cand, ixs: x.r.instructions.map(instructionName).join(">"), signers: V.signers.length, accounts: V.staticAccounts,
      legacy: L.size, v0: V.size, v0alt: A.size, altEntries: addrs.length, headroomAlt: PACKET_LIMIT - A.size });
  }
}
console.log(JSON.stringify({ label: "FIXTURE_MEASUREMENT_NOT_CHAIN_EVIDENCE", sdk: SDK_VERSIONS, globalSnapshotSlot: F.SNAPSHOT_SLOT, packetLimit: PACKET_LIMIT, rows }, null, 1));
