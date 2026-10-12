// MCPX transaction builder (Phase 04-A). Routes: GET /health, GET /ready,
// POST /internal/v1/launch/{prepare,inspect,prepare-buy,status}. Builder only: no sign/submit/broadcast.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig, FEE_SPLIT_BPS } from "./config.mjs";
import { SDK_VERSIONS, programIdsPinned, EXPECTED_PROGRAM_IDS } from "./sdk.mjs";
import { createVerifier } from "./auth.mjs";
import { validatePrepare, validateInspect, validatePrepareBuy, validateStatus } from "./contract.mjs";
import { createService } from "./service.mjs";
import { createChainDeps } from "./chain.mjs";

export const MAX_BODY = 16 * 1024;
const ROUTES = { "/health": "GET", "/ready": "GET", "/internal/v1/launch/prepare": "POST", "/internal/v1/launch/inspect": "POST",
  "/internal/v1/launch/prepare-buy": "POST", "/internal/v1/launch/status": "POST" };
const MAX_INFLIGHT = 4, PER_MINUTE = 30;

export function readyReport(cfg) {
  const pinned = programIdsPinned();
  return {
    ready: cfg.state === "READY_FOR_PREPARE" && pinned,
    configState: cfg.state, missing: cfg.missing, invalid: cfg.invalid,
    sdk: { loaded: true, versions: SDK_VERSIONS }, programIdsPinned: pinned, programs: EXPECTED_PROGRAM_IDS,
    rpcConfigured: Boolean(cfg.rpcUrl), quoteMint: cfg.quoteMint ? "CONFIGURED" : "QUOTE_MINT_MISSING",
    feeRecipients: cfg.opsRecipient && cfg.platformRecipient && !cfg.invalid.some((i) => i.startsWith("MCPX_FEE")) ? "CONFIGURED" : "MISSING",
    feeSplitBps: FEE_SPLIT_BPS, lookupTable: cfg.lookupTable ? "CONFIGURED" : "NOT_CONFIGURED",
    launchEnabled: false, capabilities: ["launch.prepare", "launch.inspect", "launch.prepare_buy", "launch.status"],
    simulationSupport: "READ_ONLY_SIMULATE_SIGVERIFY_OFF",
  };
}

export function createApp({ cfg, deps, now }) {
  const verify = cfg.secret ? createVerifier(cfg.secret, now) : null;
  const service = createService({ cfg, deps, now });
  let inflight = 0, windowStart = 0, hits = 0;

  return async function handle(req, res) {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "/").split("?")[0];
    const allowed = ROUTES[path];
    if (!allowed) return send(404, { error: "not_found" });
    if (req.method !== allowed) return send(405, { error: "method_not_allowed" }, { allow: allowed });
    if (path === "/health") return send(200, { ok: true });
    if (path === "/ready") return send(200, readyReport(cfg));

    const t = (now ?? Date.now)();
    if (t - windowStart > 60_000) { windowStart = t; hits = 0; }
    if (++hits > PER_MINUTE) return send(429, { error: "rate_limited" });
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "unsupported_media_type" });
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, { error: "too_large" }); chunks.push(c); }
    const body = Buffer.concat(chunks).toString("utf8");
    if (!verify) return send(503, { error: "NOT_CONFIGURED" });
    const authErr = verify({ headers: req.headers, method: req.method, path, body });
    if (authErr) return send(401, { error: "unauthorized" });
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(400, { error: "INVALID_REQUEST", field: "json" }); }
    const op = path.slice("/internal/v1/launch/".length);
    const v = { prepare: validatePrepare, inspect: validateInspect, "prepare-buy": validatePrepareBuy, status: validateStatus }[op](parsed);
    if (!v.ok) return send(400, { error: v.code, field: v.field });
    if (inflight >= MAX_INFLIGHT) return send(503, { error: "busy" });
    inflight++;
    try {
      const r = await { prepare: service.prepare, inspect: service.inspect, "prepare-buy": service.prepareBuy, status: service.status }[op](v.value);
      return send(r.http, r.body);
    } catch { return send(500, { error: "internal" }); }
    finally { inflight--; }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cfg = loadConfig(process.env);
  const deps = cfg.rpcUrl ? createChainDeps(cfg.rpcUrl) : { source: "chain" };
  const handle = createApp({ cfg, deps });
  const server = http.createServer((q, s) => { handle(q, s).catch(() => { try { s.writeHead(500); s.end(); } catch {} }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.listen(cfg.port, () => console.log(`mcpx-transaction-builder listening state=${cfg.state}`));
}
