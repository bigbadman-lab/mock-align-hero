// Read-only chain deps (production). Only getAccountInfo-style reads and getLatestBlockhash — no sends.
import { pump, web3, PROGRAMS } from "./sdk.mjs";

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
    async getLookupTable(addr) { return (await conn.getAddressLookupTable(new web3.PublicKey(addr))).value; },
  };
}
