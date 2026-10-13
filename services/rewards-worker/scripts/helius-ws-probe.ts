// READ-ONLY 05-H probe: LaserStream WSS transactionSubscribe (Helius extension, Developer plan) on the mint plus all
// non-zero token accounts, finalized. Measures bytes (credits = 2 per 0.1 MB) and compares the captured signature set
// with getTransactionsForAddress over the same slot range (completeness check of the live stream).
import { readFileSync, writeFileSync } from "node:fs";
import { heliusRpc, signatures, type Meter } from "../src/helius-history";
const KEY = process.env.MCPX_HELIUS_TEST_API_KEY!; const MINT = process.argv[2] ?? "8M6WhZFXoEBr6iMc1DBapDoCHEF9RZnaUpk3Q3unpump";
const SECS = Number(process.argv[3] ?? 90);
const meter0: Meter = {}; const rpc0 = heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, meter0);
let watch = [MINT];
try { const st = JSON.parse(readFileSync("/tmp/h/state.json", "utf8")); if (process.argv[4] !== "mintonly") { const bal = new Map<string, bigint>(); for (const t of st.txs) for (const b of t.post) bal.set(b.account, BigInt(b.amount)); watch = [MINT, ...[...bal].filter(([, v]) => v > 0n).map(([k]) => k)]; } } catch {}
const startSlot: number = await rpc0("getSlot", [{ commitment: "finalized" }]);
const seen = new Map<string, number>(); let bytes = 0, msgs = 0, minSlot = Infinity, maxSlot = 0;
const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${KEY}`);
const done = new Promise<void>((res) => {
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "transactionSubscribe", params: [
    { accountInclude: watch, failed: true }, { commitment: "finalized", encoding: "jsonParsed", transactionDetails: "full", maxSupportedTransactionVersion: 1 }] }));
  ws.onmessage = (e) => { const s = String(e.data); bytes += s.length; const j = JSON.parse(s);
    if (j.id === 1) { console.log("subscribed", j.result ?? j.error); return; }
    const v = j.params?.result; if (!v) return; msgs++; seen.set(v.signature, v.slot); minSlot = Math.min(minSlot, v.slot); maxSlot = Math.max(maxSlot, v.slot); };
  ws.onerror = (e) => console.log("ws error", String((e as any).message ?? e));
  setTimeout(() => { ws.close(); res(); }, SECS * 1000);
});
await done;
const meter: Meter = {}; const rpc = heliusRpc(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, meter);
await new Promise((r) => setTimeout(r, 20_000)); // let the range finalize everywhere
let missing: string[] = [];
const endSlot: number = await rpc0("getSlot", [{ commitment: "finalized" }]);
{
  const lo = startSlot + 1, hi = Math.min(endSlot - 40, msgs ? maxSlot : endSlot - 40);
  const ref = new Set<string>();
  for (const a of watch) for (const s of await signatures(rpc, meter, a, hi)) if (s.slot >= lo) ref.add(s.signature);
  missing = [...ref].filter((s) => !seen.has(s));
}
const out = { watchedAddresses: watch.length, seconds: SECS, messages: msgs, bytes, credits: (bytes / 100_000) * 2, slotRange: msgs ? [minSlot, maxSlot] : null, startSlot, endSlot,
  inHistoryButNotStreamed: missing.length };
writeFileSync("/tmp/h/ws.json", JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2));
