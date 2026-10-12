// Wallet Inspector v1 — pure, read-only Solana mainnet inspection.
// No signing, no writes, no caller-supplied URLs or RPC methods.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export const SCHEMA = "mcpx.tool-execution.wallet-inspector.v1";
export const TOOL_ID = "wallet_inspector";
export const COMMITMENT = "confirmed";
export const MAX_TOKEN_ACCOUNTS = 500; // per program
export const MAX_RPC_RESPONSE_BYTES = 2_000_000;
export const RPC_TIMEOUT_MS = 8_000;
export const PROGRAMS = {
  splToken: TOKEN_PROGRAM_ID.toBase58(),
  token2022: TOKEN_2022_PROGRAM_ID.toBase58(),
};

/** Returns canonical base58 if `s` is a valid 32-byte public key, else null. */
export function parseAddress(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return null;
  try {
    const k = new PublicKey(s);
    return k.toBytes().length === 32 && k.toBase58() === s ? s : null;
  } catch {
    return null;
  }
}

/** Integer string + decimals → exact decimal string (no floats). */
export function formatUnits(raw, decimals) {
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  if (decimals === 0) return (neg ? "-" : "") + digits;
  const padded = digits.padStart(decimals + 1, "0");
  const int = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

export class RpcError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

async function rpcCall(rpcUrl, method, params, fetchImpl, signal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    let res;
    try {
      res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
    } catch {
      throw new RpcError(ctrl.signal.aborted ? "timeout" : "network", `${method} unreachable`);
    }
    if (res.status === 429) throw new RpcError("rate_limited", `${method} rate limited by provider`);
    if (!res.ok) throw new RpcError("provider_error", `${method} HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_RPC_RESPONSE_BYTES) throw new RpcError("too_large", `${method} response too large`);
    const text = await res.text();
    if (text.length > MAX_RPC_RESPONSE_BYTES) throw new RpcError("too_large", `${method} response too large`);
    let json;
    try { json = JSON.parse(text); } catch { throw new RpcError("bad_response", `${method} invalid JSON`); }
    if (json.error) throw new RpcError("provider_error", `${method} RPC error ${json.error.code ?? ""}`.trim());
    if (!json.result || typeof json.result.context?.slot !== "number") throw new RpcError("bad_response", `${method} missing context`);
    return method === "getBalance" ? { ...json.result, rawText: text } : json.result;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

function normalizeTokenAccounts(value, program) {
  if (!Array.isArray(value)) throw new RpcError("bad_response", "token accounts not an array");
  if (value.length > MAX_TOKEN_ACCOUNTS) throw new RpcError("too_large", `more than ${MAX_TOKEN_ACCOUNTS} token accounts`);
  const byMint = new Map();
  for (const a of value) {
    const info = a?.account?.data?.parsed?.info;
    const amt = info?.tokenAmount;
    if (typeof info?.mint !== "string" || typeof amt?.amount !== "string" || !/^\d+$/.test(amt.amount) || !Number.isInteger(amt.decimals)) {
      throw new RpcError("bad_response", "unparseable token account");
    }
    const cur = byMint.get(info.mint) ?? { mint: info.mint, raw: 0n, decimals: amt.decimals, accounts: 0 };
    cur.raw += BigInt(amt.amount);
    cur.accounts += 1;
    byMint.set(info.mint, cur);
  }
  return [...byMint.values()]
    .map((h) => ({ mint: h.mint, program, amountRaw: h.raw.toString(), decimals: h.decimals, amountUi: formatUnits(h.raw.toString(), h.decimals), tokenAccounts: h.accounts }))
    .sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : BigInt(b.amountRaw) < BigInt(a.amountRaw) ? -1 : a.mint.localeCompare(b.mint)));
}

/** Runs the three allowlisted queries in parallel; partial results are flagged, never hidden. */
export async function inspectWallet({ address, rpcUrl, executionId, fetchImpl = fetch, signal, now = () => new Date() }) {
  const addr = parseAddress(address);
  if (!addr) throw new RpcError("invalid_input", "invalid address");
  const cfg = { commitment: COMMITMENT };
  const tokCfg = { commitment: COMMITMENT, encoding: "jsonParsed" };
  const [bal, spl, t22] = await Promise.allSettled([
    rpcCall(rpcUrl, "getBalance", [addr, cfg], fetchImpl, signal),
    rpcCall(rpcUrl, "getTokenAccountsByOwner", [addr, { programId: PROGRAMS.splToken }, tokCfg], fetchImpl, signal),
    rpcCall(rpcUrl, "getTokenAccountsByOwner", [addr, { programId: PROGRAMS.token2022 }, tokCfg], fetchImpl, signal),
  ]);
  const warnings = [];
  const errs = [];
  const note = (part, r) => { const k = r.reason instanceof RpcError ? r.reason.kind : "internal"; errs.push(k); warnings.push({ part, kind: k, message: `${part} unavailable (${k})` }); };

  let solBalance = null;
  // Lamports can exceed 2^53; read the exact digits from the raw JSON, never a float.
  const lam = bal.status === "fulfilled" ? /"value"\s*:\s*(\d{1,20})\s*[,}]/.exec(bal.value.rawText ?? "")?.[1] : undefined;
  if (bal.status === "fulfilled" && lam !== undefined) {
    const l = lam.replace(/^0+(?=\d)/, "");
    solBalance = { lamports: l, solUi: formatUnits(l, 9) };
  } else note("balance", bal.status === "rejected" ? bal : { reason: new RpcError("bad_response", "bad balance") });

  const holdings = [];
  const parts = { splToken: null, token2022: null };
  for (const [key, r, program] of [["splToken", spl, PROGRAMS.splToken], ["token2022", t22, PROGRAMS.token2022]]) {
    if (r.status === "fulfilled") {
      try { holdings.push(...normalizeTokenAccounts(r.value.value, program)); parts[key] = r.value.context.slot; }
      catch (e) { note(key, { reason: e }); }
    } else note(key, r);
  }
  const ok = { balance: bal.status === "fulfilled" && solBalance !== null, splToken: parts.splToken !== null, token2022: parts.token2022 !== null };
  if (!ok.balance && !ok.splToken && !ok.token2022) {
    const kind = errs.includes("rate_limited") ? "rate_limited" : errs.includes("timeout") ? "timeout" : "provider_error";
    throw new RpcError(kind, "all provider queries failed");
  }
  return {
    schema: SCHEMA,
    executionId,
    toolId: TOOL_ID,
    network: "solana-mainnet",
    commitment: COMMITMENT,
    source: "Solana mainnet via configured RPC",
    address: addr,
    fetchedAt: now().toISOString(),
    solBalance,
    tokenHoldings: holdings,
    sourceSlots: { balance: ok.balance ? bal.value.context.slot : null, splToken: parts.splToken, token2022: parts.token2022 },
    coverage: ok,
    partial: !(ok.balance && ok.splToken && ok.token2022),
    warnings,
  };
}
