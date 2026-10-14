// CANVAS-01 final: launch verifier decisions + Canvas products on the product MCP endpoint. Fixtures only.
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/canvas/adapters", async (orig) => {
  const m = await orig<typeof import("@/lib/canvas/adapters")>();
  return { ...m, CANVAS_ADAPTERS: Object.fromEntries(Object.entries(m.CANVAS_ADAPTERS).map(([k, a]) => [k, { ...a, check: () => true }])) };
});
import { verifyLaunch, runLaunchVerifier, PUMP_PROGRAM, type Claim, type LaunchTx } from "../../services/rewards-worker/src/launch-verify";
import { TOKEN_2022, type OnchainChild } from "../../services/rewards-worker/src/child-fees";
import { executeCanvasTool } from "@/lib/mcp-gateway/canvas";
import { handleProductMcp, type ExecDeps } from "@/lib/mcp-gateway/server";
import type { ProductDeps } from "@/lib/mcp-gateway/products";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";

const B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const k = (n = 44) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => B[x % 58]).join("");
const creator = k(), mint = k(), ops = k(), platform = k(), deployer = k(), quote = k(), sc = k();
const claim: Claim = { id: "c1", draftId: "d", draftRevision: 1, creator, mint, signature: k(88) };
const a = { ops, platform, nativeDeployer: deployer };
const tx = (o: Partial<Extract<LaunchTx, { found: true }>> = {}): LaunchTx => ({ found: true, finalized: true, err: null, slot: 9, accountKeys: [creator, mint, PUMP_PROGRAM], numSigners: 2, programIds: [PUMP_PROGRAM], ...o });
const chain = (o: Partial<OnchainChild> = {}, sh = [[creator, 6000], [ops, 2500], [platform, 1500]] as [string, number][]): OnchainChild => ({
  sharingConfig: { mint, adminRevoked: true, shareholders: sh.map(([address, shareBps]) => ({ address, shareBps })) }, curveCreator: sc, curveQuoteMint: quote, quoteMintOwner: TOKEN_2022, graduated: false, ...o });
const v = (t = tx(), c = chain(), q: string | null = quote) => verifyLaunch(claim, t, c, q, TOKEN_2022, a, sc);

describe("post-launch verifier", () => {
  it("accepts a finalized, successful creator-paid Pump launch with locked 60/25/15 and $MCP quote", () => {
    expect(v()).toMatchObject({ ok: true, slot: 9 });
  });
  it("holds (never rejects) when evidence is missing or not yet final", () => {
    expect(v({ found: false })).toMatchObject({ ok: false, code: "TX_NOT_FOUND", final: false });
    expect(v(tx({ finalized: false }))).toMatchObject({ final: false });
    expect(v(tx(), chain(), null)).toMatchObject({ code: "QUOTE_MINT_UNSET", final: false });
    expect(verifyLaunch(claim, tx(), null, quote, TOKEN_2022, a, sc)).toMatchObject({ code: "EVIDENCE_UNAVAILABLE", final: false });
  });
  it("rejects failed, tampered or unrelated transactions", () => {
    expect(v(tx({ err: { InstructionError: [0, "x"] } }))).toMatchObject({ code: "TX_FAILED", final: true });
    expect(v(tx({ accountKeys: [k(), mint, PUMP_PROGRAM] }))).toMatchObject({ code: "FEE_PAYER_NOT_CREATOR" });
    expect(v(tx({ numSigners: 1 }))).toMatchObject({ code: "MINT_NOT_CREATED_IN_TX" });
    expect(v(tx({ programIds: [k()] }))).toMatchObject({ code: "NOT_A_PUMP_LAUNCH" });
  });
  it("rejects wrong splits, substituted wallets, unlocked config or wrong quote", () => {
    expect(v(tx(), chain({}, [[k(), 6000], [ops, 2500], [platform, 1500]]))).toMatchObject({ ok: false, final: true });
    expect(v(tx(), chain({}, [[creator, 5000], [ops, 3500], [platform, 1500]]))).toMatchObject({ code: "SHARES_MISMATCH" });
    expect(v(tx(), chain({}, [[creator, 6000], [deployer, 2500], [platform, 1500]]))).toMatchObject({ ok: false });
    expect(v(tx(), chain({ sharingConfig: { mint, adminRevoked: false, shareholders: chain().sharingConfig!.shareholders } }))).toMatchObject({ code: "SHARES_NOT_LOCKED" });
    expect(v(tx(), chain({ curveQuoteMint: k() }))).toMatchObject({ code: "CURVE_QUOTE_MISMATCH" });
  });
  it("registers only verified claims; rejects final failures; retries holds", async () => {
    const calls: string[] = [];
    const bad = { ...claim, id: "c2", signature: k(88) };
    const out = await runLaunchVerifier({
      pending: async () => [claim, bad],
      readTx: async (s) => (s === claim.signature ? tx() : tx({ err: "boom" })),
      readChild: async () => chain(), quoteProgram: async () => TOKEN_2022, sharingConfigOf: () => sc,
      register: async (id) => { calls.push(`reg:${id}`); return "registered:x"; },
      reject: async (id, c) => { calls.push(`rej:${id}:${c}`); return "rejected"; },
    }, quote, a);
    expect(calls).toEqual(["reg:c1", "rej:c2:TX_FAILED"]);
    expect(out.map((x) => x.result)).toEqual(["registered:x", "REJECTED:TX_FAILED"]);
  });
});

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const cfg = { catalogVersion: 1, steps: [{ capabilityId: "intel.holders", version: 1 }, { capabilityId: "wallet.inspect", version: 1, from: { step: 0, output: "largest_owner" } }], ai: { summarize: true as const } };
const outs = [{ executionId: "e1", distribution: { owners: [{ owner: OWNER }] } }, { executionId: "e2", tokenHoldings: [] }];

describe("Canvas on the product MCP endpoint", () => {
  it("executes the stored pipeline step by step through shared limits; AI only when requested and active", async () => {
    let n = 0, takes = 0, ai = 0;
    const r = await executeCanvasTool(cfg, 3, { input: MINT, ai_summary: true }, {
      available: async () => true, take: async () => { takes++; return "ok"; }, execute: async () => ({ ok: true, out: outs[n++] }),
      summarise: async () => { ai++; return { status: "ok", text: "S", model: "gpt-4o-mini" }; } });
    expect(takes).toBe(2); expect(ai).toBe(1);
    expect(r.structuredContent).toMatchObject({ canvasVersion: 3, complete: true, aiSummary: { status: "ok" } });
  });
  it("rate limits surface as errors and stop the pipeline; callers can't add steps or fields", async () => {
    const r = await executeCanvasTool(cfg, 1, { input: MINT }, { available: async () => true, take: async () => "limited", execute: async () => ({ ok: true, out: {} }) });
    expect(r.isError).toBe(true);
    expect((await executeCanvasTool(cfg, 1, { input: MINT, steps: [] }, { available: async () => true, take: async () => "ok", execute: async () => ({ ok: true, out: {} }) })).isError).toBe(true);
  });
  const deps = (over: Partial<ProductDeps> = {}): ProductDeps => ({
    getVerifiedCreation: async () => ({ id: ID, templateId: "canvas", templateVersion: 1, displayName: "Canvas P" }),
    getProductConfig: async () => ({ creationId: ID, templateId: "canvas", templateVersion: "1.0.0", configVersion: 1, toolConfig: {}, accessMode: "credential_required", lifecycleState: "active" }),
    authorizeProduct: async (_p, t) => t === "good", getCanvasVersion: async () => ({ version: 2, config: cfg }), ...over });
  const ID = "11111111-1111-4111-8111-111111111111";
  const exec: ExecDeps = { workerConfig: () => ({ url: "x", secret: "s" }) as any, toolAvailability: async () => ({ available: true }) as any, takeShared: async () => "ok", callWorker: async () => ({ ok: true, out: {} }) as any };
  const list = (t = "good") => new Request("https://mcpx.fun/x", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  it("lists exactly one run_canvas tool for an authorized active Canvas product", async () => {
    const r = await handleProductMcp(ID, list(), deps(), exec);
    const b = await r.json();
    expect(b.result.tools.map((t: any) => t.name)).toEqual(["run_canvas"]);
  });
  it("wrong key → 401; unbound, inactive or missing-version products → 404", async () => {
    expect((await handleProductMcp(ID, list("bad"), deps(), exec)).status).toBe(401);
    expect((await handleProductMcp(ID, list(), deps({ getCanvasVersion: async () => null }), exec)).status).toBe(404);
    expect((await handleProductMcp(ID, list(), deps({ getCanvasVersion: undefined }), exec)).status).toBe(404);
    const inactive = deps({ getProductConfig: async () => ({ creationId: ID, templateId: "canvas", templateVersion: "1.0.0", configVersion: 1, toolConfig: {}, accessMode: "credential_required", lifecycleState: "inactive" }) });
    expect((await handleProductMcp(ID, list(), inactive, exec)).status).toBe(404);
  });
  it("the ten single-tool adapters are unchanged and Canvas isn't one of them", () => {
    expect(Object.keys(ADAPTERS)).not.toContain("canvas");
  });
});
