// Read-only chain deps (production). Only getAccountInfo-style reads and getLatestBlockhash — no sends.
import { pump, web3, spl, PROGRAMS } from "./sdk.mjs";

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
    async simulate(messageBytes) {
      const tx = new web3.VersionedTransaction(web3.VersionedMessage.deserialize(messageBytes));
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      return { err: r.value.err, unitsConsumed: r.value.unitsConsumed ?? null, logs: r.value.logs ?? [], slot: r.context.slot };
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
