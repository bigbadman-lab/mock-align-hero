// 05-F read-only holder-history feasibility probe. Never signs or sends. Usage: node holder-history-probe.mjs <mint> <lookbackSlots> [rpc]
// Method: enumerate all current token accounts (finalized), then for every account read its signatures back to S0 and take the
// pre-balance of its earliest post-S0 transaction as its balance at S0. Reconstructed sum is compared with supply.
const [mint, lookArg, rpcArg] = process.argv.slice(2);
const RPC = rpcArg ?? "https://api.mainnet-beta.solana.com", LOOK = Number(lookArg ?? 9000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0, throttled = 0;
async function rpc(method, params) {
  for (let i = 0; i < 8; i++) {
    calls++;
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30000) }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (j && j.result !== undefined) return j.result;
    throttled++; await sleep(500 * 2 ** i);
  }
  throw new Error(`rpc_unavailable:${method}`);
}
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const info = await rpc("getAccountInfo", [mint, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "finalized" }]);
const program = info.value.owner;
const now = await rpc("getSlot", [{ commitment: "finalized" }]); const S0 = now - LOOK;
const supplyNow = BigInt((await rpc("getTokenSupply", [mint, { commitment: "finalized" }])).value.amount);
const filters = [{ memcmp: { offset: 0, bytes: mint } }, ...(program === T22 ? [] : [{ dataSize: 165 }])];
const g = await rpc("getProgramAccounts", [program, { encoding: "jsonParsed", filters, withContext: true, commitment: "finalized" }]);
const accts = g.value.map((a) => ({ pubkey: a.pubkey, ...a.account.data.parsed.info }));
let sumNow = 0n; for (const a of accts) sumNow += BigInt(a.tokenAmount.amount);
const res = { mint, program: program === T22 ? "Token-2022" : "SPL Token", rpc: RPC.replace(/\?.*$/, ""), gpaSlot: g.context.slot, finalizedSlot: now, S0, accountsNow: accts.length, supplyNow: String(supplyNow), sumNow: String(sumNow), currentReconciled: sumNow === supplyNow };
// history
let active = 0, createdAfter = 0, truncated = 0; let sumS0 = 0n; const pastOwners = new Map(); const gaps = [];
const queue = [...accts]; const work = async () => {
  for (let a; (a = queue.shift()); ) {
    let before, earliest = null, done = false;
    for (let page = 0; page < 5 && !done; page++) {
      const sigs = await rpc("getSignaturesForAddress", [a.pubkey, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]);
      for (const s of sigs) { if (s.slot <= S0) { done = true; break; } earliest = s; }
      if (sigs.length < 1000) done = true; else before = sigs[sigs.length - 1].signature;
      if (!done && page === 4) { truncated++; gaps.push(a.pubkey); }
    }
    let bal = BigInt(a.tokenAmount.amount), owner = a.owner;
    if (earliest) {
      active++;
      const tx = await rpc("getTransaction", [earliest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
      const idx = keys.indexOf(a.pubkey);
      const pre = tx.meta.preTokenBalances.find((b) => b.accountIndex === idx && b.mint === mint);
      if (!pre) { createdAfter++; bal = 0n; } else { bal = BigInt(pre.uiTokenAmount.amount); owner = pre.owner ?? owner; }
    }
    if (bal > 0n) { sumS0 += bal; pastOwners.set(owner, (pastOwners.get(owner) ?? 0n) + bal); }
  }
};
await Promise.all(Array.from({ length: 4 }, work));
Object.assign(res, { activeSinceS0: active, createdSinceS0: createdAfter, historyTruncated: truncated, reconstructedSumAtS0: String(sumS0), ownersAtS0: pastOwners.size,
  unexplainedDeltaVsSupplyNow: String(sumS0 - supplyNow), rpcCalls: calls, throttledRetries: throttled,
  verdict: sumS0 === supplyNow && truncated === 0 ? "RECONCILED_ASSUMING_NO_SUPPLY_CHANGE_AND_NO_CLOSED_ACCOUNTS" : "NOT_RECONCILED_CLOSED_ACCOUNTS_OR_SUPPLY_CHANGE_UNACCOUNTED" });
console.log(JSON.stringify(res, null, 1));
