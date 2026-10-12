// MCPX MCP-execution worker (Render). Independent process: no database, no signing keys.
// Routes: GET /health, GET /ready, POST /internal/v1/tools/execute (HMAC-signed).
import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { inspectWallet, parseAddress, RpcError, TOOL_ID, SCHEMA } from "./inspect.mjs";
import { verifyTransaction, parseSignature, TV_TOOL_ID, TV_SCHEMA } from "./verify.mjs";
import { scanToken, TS_TOOL_ID, TS_SCHEMA } from "./scan.mjs";
import { monitorSupply, SM_TOOL_ID, SM_SCHEMA } from "./supply.mjs";
import { checkAccount, AC_TOOL_ID, AC_SCHEMA } from "./account.mjs";
import { watchWhales, validInput as wwValid, WW_TOOL_ID, WW_SCHEMA } from "./whale.mjs";

const PORT = Number(process.env.PORT ?? 10000);
const RPC_URL = process.env.HELIUS_RPC_URL ?? "";
const SECRET = process.env.MCPX_WORKER_SECRET ?? "";
const MAX_BODY = 2048;
const SKEW_MS = 60_000;
const MAX_CONCURRENT = 8;
const PER_MINUTE = 60; // whole-worker cap shared by all tools; the website enforces per-visitor limits
const REQUEST_TIMEOUT_MS = 20_000;

// Strict allowlist: schema + exact input key + validator + runner + log summary.
const TOOLS = {
  [TOOL_ID]: { schema: SCHEMA, key: "address", valid: parseAddress, run: (v, o) => inspectWallet({ address: v, ...o }), summary: (out) => ({ status: out.partial ? "partial" : "ok", holdings: out.tokenHoldings.length }) },
  [TV_TOOL_ID]: { schema: TV_SCHEMA, key: "signature", valid: parseSignature, run: (v, o) => verifyTransaction({ signature: v, ...o }), summary: (out) => ({ status: out.found ? "found" : "not_found", execution: out.execution }) },
  [TS_TOOL_ID]: { schema: TS_SCHEMA, key: "mint", valid: parseAddress, run: (v, o) => scanToken({ mint: v, ...o }), summary: (out) => ({ status: out.status, program: out.program }) },
  [SM_TOOL_ID]: { schema: SM_SCHEMA, key: "mint", valid: parseAddress, run: (v, o) => monitorSupply({ mint: v, ...o }), summary: (out) => ({ status: out.status, partial: out.partial ?? null, accounts: out.distribution?.accounts.length ?? 0 }) },
  // Multi-field input: `whole` validates the entire input object (exact keys) instead of one key.
  [WW_TOOL_ID]: { schema: WW_SCHEMA, whole: wwValid, run: (i, o) => watchWhales({ ...i, ...o }), summary: (out) => ({ complete: out.complete, transfers: out.transfers.length, attempted: out.coverage.transactionsAttempted }) },
  [AC_TOOL_ID]: { schema: AC_SCHEMA, key: "address", valid: parseAddress, run: (v, o) => checkAccount({ address: v, ...o }), summary: (out) => ({ exists: out.exists, classification: out.classification }) },
};

const seenNonces = new Map();
let inFlight = 0;
let windowStart = Date.now(), windowHits = 0;

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); // never logs bodies, headers, addresses or signatures
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const ready = () => RPC_URL.startsWith("https://") && SECRET.length >= 32;

function verify(req, body) {
  const ts = String(req.headers["x-mcpx-timestamp"] ?? "");
  const nonce = String(req.headers["x-mcpx-nonce"] ?? "");
  const sig = String(req.headers["x-mcpx-signature"] ?? "");
  if (!/^\d{13}$/.test(ts) || !/^[0-9a-f-]{36}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Date.now() - Number(ts)) > SKEW_MS) return false;
  const expected = createHmac("sha256", SECRET).update(`${ts}.${nonce}.${body}`).digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + 2 * SKEW_MS);
  return true;
}

createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && url === "/ready") return send(res, ready() ? 200 : 503, { ready: ready(), tools: ready() ? Object.keys(TOOLS) : [] });
  if (req.method !== "POST" || url !== "/internal/v1/tools/execute") return send(res, 404, { error: "not_found" });
  if (!ready()) return send(res, 503, { error: "not_configured" });

  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { send(res, 413, { error: "too_large" }); req.destroy(); } else chunks.push(c); });
  req.on("end", async () => {
    if (size > MAX_BODY) return;
    const body = Buffer.concat(chunks).toString("utf8");
    if (!verify(req, body)) return send(res, 401, { error: "unauthorized" });
    let input;
    try { input = JSON.parse(body); } catch { return send(res, 400, { error: "invalid_input" }); }
    const keys = input && typeof input === "object" ? Object.keys(input).sort().join(",") : "";
    const tool = keys === "input,schema,toolId" && Object.hasOwn(TOOLS, input.toolId) ? TOOLS[input.toolId] : null;
    if (!tool || input.schema !== tool.schema) return send(res, 400, { error: "unsupported_tool" });
    if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) return send(res, 400, { error: "invalid_input" });
    const okInput = tool.whole ? tool.whole(input.input) : Object.keys(input.input).join(",") === tool.key && tool.valid(input.input[tool.key]);
    if (!okInput) return send(res, 400, { error: "invalid_input" });

    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); windowHits = 0; }
    if (++windowHits > PER_MINUTE || inFlight >= MAX_CONCURRENT) return send(res, 429, { error: "busy" });
    inFlight++;
    const executionId = randomUUID();
    const started = Date.now();
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    res.on("close", () => ctrl.abort());
    try {
      const out = await tool.run(tool.whole ? input.input : input.input[tool.key], { rpcUrl: RPC_URL, executionId, signal: ctrl.signal });
      log({ executionId, tool: input.toolId, ms: Date.now() - started, ...tool.summary(out) });
      send(res, 200, out);
    } catch (e) {
      const kind = e instanceof RpcError ? e.kind : "internal";
      log({ executionId, tool: input.toolId, status: "error", kind, ms: Date.now() - started });
      send(res, kind === "invalid_input" ? 400 : 502, { error: kind, executionId });
    } finally { clearTimeout(kill); inFlight--; }
  });
}).listen(PORT, () => log({ msg: "mcpx worker listening", port: PORT, ready: ready(), tools: Object.keys(TOOLS) }));
