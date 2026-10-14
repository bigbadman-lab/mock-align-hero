// Read-only chain deps (production). Only getAccountInfo-style reads and getLatestBlockhash — no sends.
import { pump, web3, spl, PROGRAMS } from "./sdk.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  let n = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) throw new Error("b58"); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of str) { if (ch !== "1") break; out.unshift(0); }
  return Buffer.from(out);
}
/** Anchor emit_cpi tag: events are self-CPI instruction data, not "Program data:" logs. */
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
export function cpiEventsOf(inner, programId) {
  const out = [];
  for (const g of inner ?? []) for (const ix of g.instructions ?? []) {
    const pid = typeof ix.programId === "string" ? ix.programId : ix.programId?.toBase58?.();
    if (pid !== programId || typeof ix.data !== "string") continue;
    let d; try { d = b58decode(ix.data); } catch { continue; }
    if (d.length > 8 && d.subarray(0, 8).equals(EVENT_IX_TAG)) out.push(d.subarray(8));
  }
  return out;
}

export function createChainDeps(rpcUrl) {
  const conn = new web3.Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const online = new pump.OnlinePumpSdk(conn);
  return {
    source: "chain",
    getGlobal: () => online.fetchGlobal(),
    getFeeConfig: () => online.fetchFeeConfig(),
    async getQuoteTokenProgram(mint) {
      const info = await conn.getAccountInfo(new web3.PublicKey(mint));
      if (!info) return null;
      const o = info.owner.toBase58();
      return o === PROGRAMS.token.toBase58() || o === PROGRAMS.token2022.toBase58() ? info.owner : new web3.PublicKey(o);
    },
    getPumpQuote: (mint, global) => online.fetchPumpQuote(new web3.PublicKey(mint), { global }),
    getLatestBlockhash: () => conn.getLatestBlockhash("confirmed"),
    getSlot: () => conn.getSlot("confirmed"),
    /** Read-only simulation: sigVerify off, blockhash replaced. Nothing is sent. */
    async simulate(messageBytes, watch = []) {
      const tx = new web3.VersionedTransaction(web3.VersionedMessage.deserialize(messageBytes));
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true,
        ...(watch.length ? { accounts: { encoding: "base64", addresses: watch } } : {}) });
      return { err: r.value.err, unitsConsumed: r.value.unitsConsumed ?? null, logs: r.value.logs ?? [], slot: r.context.slot,
        cpiEvents: cpiEventsOf(r.value.innerInstructions, PROGRAMS.pumpFees.toBase58()),
        postAccounts: (r.value.accounts ?? []).map((a) => (a?.data?.[0] ? Buffer.from(a.data[0], "base64") : null)) };
    },
    async getMintState(mint) {
      const m = new web3.PublicKey(mint);
      const [mi, bci, sci] = await conn.getMultipleAccountsInfo([m, pump.bondingCurvePda(m), pump.feeSharingConfigPda(m)]);
      const bondingCurve = bci ? pump.PUMP_SDK.decodeBondingCurve(bci) : null;
      let curveBaseTokenBalance = null, mintSupply = null;
      if (mi && bondingCurve) {
        const ata = spl.getAssociatedTokenAddressSync(m, pump.bondingCurvePda(m), true, mi.owner);
        curveBaseTokenBalance = (await conn.getTokenAccountBalance(ata)).value.amount;
        mintSupply = (await conn.getTokenSupply(m)).value.amount;
      }
      return { mintOwner: mi ? mi.owner.toBase58() : null, bondingCurve, sharingConfig: sci ? pump.PUMP_SDK.decodeSharingConfig(sci) : null, curveBaseTokenBalance, mintSupply };
    },
    async getLookupTable(addr) { return (await conn.getAddressLookupTable(new web3.PublicKey(addr))).value; },
  };
}
