// On-chain creation verification (status + separate-buy precondition) and simulation-event checks.
import { pump, web3 } from "./sdk.mjs";
import { FEE_SPLIT_BPS } from "./config.mjs";

const key = (s) => `${s.address}:${s.bps}`;
export const expectedShares = (creator, cfg) => [
  { address: creator, bps: FEE_SPLIT_BPS.creator },
  { address: cfg.opsRecipient, bps: FEE_SPLIT_BPS.ops },
  { address: cfg.platformRecipient, bps: FEE_SPLIT_BPS.platform },
];
const sameShares = (a, b) => a.length === b.length && new Set(a.map(key)).size === a.length && a.every((s) => b.some((t) => key(t) === key(s)));

/**
 * @param st {{ mintOwner:string|null, bondingCurve:any|null, sharingConfig:any|null }} decoded chain state
 * @returns {{ state:"NOT_FOUND"|"CREATED_FEE_VERIFIED"|"CREATED_FEE_MISMATCH", code?:string }}
 */
export function verifyCreated(st, { mint, creator, cfg }) {
  if (!st.mintOwner && !st.bondingCurve) return { state: "NOT_FOUND" };
  const bad = (code) => ({ state: "CREATED_FEE_MISMATCH", code });
  const bc = st.bondingCurve;
  if (!bc) return bad("CURVE_NOT_FOUND");
  if (bc.quoteMint.toBase58() !== cfg.quoteMint) return bad("QUOTE_MINT_MISMATCH");
  if (bc.creator.toBase58() !== pump.feeSharingConfigPda(new web3.PublicKey(mint)).toBase58()) return bad("CURVE_CREATOR_NOT_SHARING_CONFIG");
  const sc = st.sharingConfig;
  if (!sc) return bad("SHARING_CONFIG_NOT_FOUND");
  if (sc.mint.toBase58() !== mint) return bad("SHARING_CONFIG_MINT_MISMATCH");
  if (sc.admin.toBase58() !== creator) return bad("SHARING_ADMIN_MISMATCH");
  const got = sc.shareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));
  if (!sameShares(got, expectedShares(creator, cfg))) return bad("FEE_SHARES_MISMATCH");
  if (bc.complete) return { state: "CREATED_FEE_VERIFIED", curveComplete: true };
  return { state: "CREATED_FEE_VERIFIED", curveComplete: false };
}

/** Decodes Anchor events from simulation logs ("Program data: <base64>"), tolerant of discriminator framing. */
// Anchor event discriminators (sha256("event:<Name>")[0..8]). SDK decoders do not check them, so we do.
export const EVENT_DISC = { create: "8569aac8b874fb58", update: "15bac4b85be4e1cb" };
function decodeEvents(logs, decoder, cpiEvents = [], disc = null) {
  const out = [], seen = new Set();
  // The same event can surface both as a self-CPI and as a "Program data:" log; count identical bytes once.
  const once = (b) => { const h = b.toString("hex"); if (seen.has(h)) return false; seen.add(h); return true; };
  for (const buf of cpiEvents) {
    if (!disc || buf.length <= 8 || buf.subarray(0, 8).toString("hex") !== disc) continue;
    if (!once(buf)) continue;
    try { const ev = decoder(buf.subarray(8)); if (ev) out.push(ev); } catch { /* malformed */ }
  }
  for (const l of logs ?? []) {
    if (!l.startsWith("Program data: ")) continue;
    const buf = Buffer.from(l.slice(14), "base64");
    if (disc && (buf.length <= 8 || buf.subarray(0, 8).toString("hex") !== disc)) continue;
    if (disc && !once(buf)) continue;
    for (const d of disc ? [buf.subarray(8)] : [buf, buf.subarray(8)]) { try { const ev = decoder(d); if (ev) { out.push(ev); break; } } catch { /* not this event */ } }
  }
  return out;
}

/**
 * Fee-first proof from a real simulation: the config starts as creator=10000 and the update leaves
 * exactly the fixed 60/25/15 set. Returns null when verified, else a reason code.
 */
export function verifySimulationEvents(logs, { mint, creator, cfg }, cpiEvents = []) {
  const sdk = pump.PUMP_SDK;
  const created = decodeEvents(logs, (d) => { const e = sdk.decodeCreateFeeSharingConfigEvent(d); return e?.initialShareholders ? e : null; }, cpiEvents, EVENT_DISC.create);
  const updated = decodeEvents(logs, (d) => { const e = sdk.decodeUpdateFeeSharesEvent(d); return e?.newShareholders ? e : null; }, cpiEvents, EVENT_DISC.update);
  if (created.length !== 1 || updated.length !== 1) return "SIMULATION_EVENTS_MISSING";
  const c = created[0], u = updated[0];
  if (c.mint.toBase58() !== mint || u.mint.toBase58() !== mint) return "SIMULATION_EVENT_MINT_MISMATCH";
  const init = c.initialShareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));
  if (!sameShares(init, [{ address: creator, bps: 10000 }])) return "SIMULATION_INITIAL_SHARES_UNEXPECTED";
  const fin = u.newShareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));
  if (!sameShares(fin, expectedShares(creator, cfg))) return "SIMULATION_FINAL_SHARES_MISMATCH";
  return null;
}
