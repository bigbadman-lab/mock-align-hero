// Website "Use Tool" execution for launched products (Token Scanner v1). Fixtures exist only in this file.
import { describe, expect, it } from "vitest";
import { runProductTool, type RunDeps } from "@/lib/product-run";
import type { PublicProfile } from "@/lib/product-profile";
import { adapterExact } from "@/lib/mcp-gateway/registry";
import { TS_SCHEMA } from "@/lib/tools/token-scanner";
import { formatSupply, supplyCheckText } from "@/components/mcpx/product-run/TokenScannerApp";

const MINT = "J9mJvEZeJ2XZTYZggPJiM6AiGxtaGHCAS8Y3uinfi59E";
const ID = "023879d8-55b8-468d-91fa-643065b67120";
const profile = (over: Partial<PublicProfile> = {}): PublicProfile => ({
  creationId: ID, slug: "hee-j9mjveze", displayName: "Hee", ticker: "HEE", description: "", templateId: "token-scanner",
  templateName: "Token Scanner", engine: "TOKEN", templateVersion: 1, creatorWallet: "W", childMint: MINT, quoteMint: "Q",
  network: "solana-mainnet", verifiedTx: "S", verifiedSlot: 1, verifiedAt: "2026-01-01T00:00:00Z", rehearsal: true, imageUrl: null,
  availability: "active", tool: { name: "token_scanner", adapterVersion: "1.0.0", title: "", description: "", inputSchema: "{}", fixedSettings: [] },
  endpoint: "https://mcpx.fun/api/public/mcp/products/" + ID, ...over,
});
const result = (over: Record<string, unknown> = {}) => ({
  schema: TS_SCHEMA, executionId: "e1", toolId: "token_scanner", network: "solana-mainnet", source: "helius", commitment: "confirmed",
  mint: MINT, fetchedAt: "2026-01-01T00:00:00Z", accountSlot: 5, status: "mint", program: "spl-token", owner: "o", accountType: "mint",
  isInitialized: true, decimals: 6, supplyRaw: "1000000000000000", supplyUi: "1000000000", mintAuthority: null, freezeAuthority: null,
  extensions: null, extensionsComplete: null, supplyCheck: { status: "ok", slot: 5, supplyRaw: "1000000000000000", matches: true }, ...over,
});

function deps(o: { prof?: PublicProfile | "nf" | "down"; lim?: "ok" | "limited" | "free_limit" | "unavailable"; worker?: { ok: true; out: unknown } | { ok: false; status: number; error: string }; avail?: boolean; settings?: Record<string, string> } = {}) {
  const calls = { take: [] as (string | undefined)[], worker: [] as string[], activity: [] as unknown[] };
  const d: RunDeps = {
    async resolve() {
      const p = o.prof ?? profile();
      if (p === "nf") return { result: { status: "not_found" }, adapter: null, settings: null };
      if (p === "down") return { result: { status: "unavailable" }, adapter: null, settings: null };
      return { result: { status: "ok", profile: p }, adapter: adapterExact(p.templateId, "1.0.0"), settings: o.settings ?? {} };
    },
    workerConfig: () => ({ url: "https://w", secret: "s".repeat(32) }),
    toolAvailability: async () => (o.avail === false ? { available: false, reason: "x" } : { available: true }) as never,
    takeShared: async (_c, _r, t) => { calls.take.push(t); return o.lim ?? "ok"; },
    callWorker: async (_c, payload) => { calls.worker.push(payload); return o.worker ?? { ok: true, out: result() }; },
    recordActivity: async (e) => { calls.activity.push(e); },
  };
  return { d, calls };
}
const req = new Request("https://mcpx.fun/api/products/hee-j9mjveze/run", { method: "POST" });

describe("product website execution", () => {
  it("runs the real token_scanner payload with the shared per-tool free bucket and records one activity row", async () => {
    const { d, calls } = deps();
    const r = await runProductTool(d, "hee-j9mjveze", { mint: MINT }, req);
    expect(r.status).toBe(200);
    expect(JSON.parse(calls.worker[0]!)).toEqual({ schema: TS_SCHEMA, toolId: "token_scanner", input: { mint: MINT } });
    expect(calls.take).toEqual(["token_scanner"]); // same 3/day bucket as the Tool Library page
    expect(calls.activity).toHaveLength(1);
    expect(calls.activity[0]).toMatchObject({ creationId: ID, toolId: "token_scanner", outcome: "ok" });
    expect(JSON.stringify(calls.activity[0])).not.toContain(MINT); // never stores the submitted input
  });
  it("rejects invalid base58 / extra fields before any quota or worker call", async () => {
    for (const body of [{ mint: "not-a-key" }, { mint: MINT, extra: 1 }, { mint: 5 }, null, [MINT]]) {
      const { d, calls } = deps();
      expect((await runProductTool(d, "hee-j9mjveze", body, req)).body).toEqual({ error: "invalid_input" });
      expect(calls.take).toEqual([]); expect(calls.worker).toEqual([]);
    }
  });
  it("enforces the daily free limit server-side", async () => {
    const { d, calls } = deps({ lim: "free_limit" });
    expect(await runProductTool(d, "hee-j9mjveze", { mint: MINT }, req)).toEqual({ status: 429, body: { error: "free_limit" } });
    expect(calls.worker).toEqual([]); expect(calls.activity).toEqual([]);
  });
  it("rejects unknown, inactive, suspended and non-interactive products", async () => {
    expect((await runProductTool(deps({ prof: "nf" }).d, "x", { mint: MINT }, req)).status).toBe(404);
    expect((await runProductTool(deps({ prof: "down" }).d, "x", { mint: MINT }, req)).status).toBe(503);
    for (const availability of ["inactive", "suspended", "misconfigured"] as const)
      expect((await runProductTool(deps({ prof: profile({ availability }) }).d, "x", { mint: MINT }, req)).body).toEqual({ error: "product_inactive" });
    expect((await runProductTool(deps({ prof: profile({ templateId: "canvas" }) }).d, "x", { mint: MINT }, req)).body).toEqual({ error: "not_runnable" });
  });
  it("passes RPC errors/timeouts through as safe kinds and records one error row", async () => {
    const { d, calls } = deps({ worker: { ok: false, status: 504, error: "timeout" } });
    expect(await runProductTool(d, "x", { mint: MINT }, req)).toEqual({ status: 504, body: { error: "timeout" } });
    expect(calls.activity).toHaveLength(1);
  });
  it("refuses unverifiable worker output", async () => {
    const { d } = deps({ worker: { ok: true, out: result({ mint: "other" }) } });
    expect((await runProductTool(d, "x", { mint: MINT }, req)).body).toEqual({ error: "bad_response" });
  });
  it("no activity recorder (flag off) → still runs, nothing recorded", async () => {
    const { d } = deps(); delete d.recordActivity;
    expect((await runProductTool(d, "x", { mint: MINT }, req)).status).toBe(200);
  });
});

describe("other templates", () => {
  it("Whale Watch uses the product's server-fixed threshold; callers cannot override it", async () => {
    const { d, calls } = deps({ prof: profile({ templateId: "whale-watch" }), settings: { minLamports: "1000000000" }, worker: { ok: false, status: 502, error: "provider_error" } });
    await runProductTool(d, "x", { address: MINT }, req);
    expect(JSON.parse(calls.worker[0]!).input).toEqual({ address: MINT, minLamports: "1000000000" });
    expect(calls.take).toEqual(["whale_watch"]);
    const d2 = deps({ prof: profile({ templateId: "whale-watch" }), settings: { minLamports: "1000000000" } });
    expect((await runProductTool(d2.d, "x", { address: MINT, minLamports: "1" }, req)).body).toEqual({ error: "invalid_input" });
  });
  it("Smart Money Tracker accepts 1–3 unique wallets only", async () => {
    const pr = profile({ templateId: "smart-money-tracker" });
    const { d, calls } = deps({ prof: pr, worker: { ok: false, status: 502, error: "provider_error" } });
    await runProductTool(d, "x", { wallets: [MINT] }, req);
    expect(JSON.parse(calls.worker[0]!).input).toEqual({ wallets: [MINT] });
    expect((await runProductTool(deps({ prof: pr }).d, "x", { wallets: [MINT, MINT] }, req)).status).toBe(400);
    expect((await runProductTool(deps({ prof: pr }).d, "x", { wallets: [] }, req)).status).toBe(400);
  });
  it("Onchain Report Builder requires a target type", async () => {
    const pr = profile({ templateId: "onchain-report-builder" });
    expect((await runProductTool(deps({ prof: pr }).d, "x", { target: MINT }, req)).status).toBe(400);
  });
});

describe("token scanner result formatting", () => {
  it("formats supply with verified decimals without float loss", () => {
    expect(formatSupply("1000000000000000", 6)).toBe("1,000,000,000");
    expect(formatSupply("123456789", 9)).toBe("0.123456789");
    expect(formatSupply("1500", 3)).toBe("1.5");
    expect(formatSupply("42", 0)).toBe("42");
  });
  it("describes supplyCheck only from the tool result", () => {
    expect(supplyCheckText({ status: "ok", slot: 1, supplyRaw: "1", matches: true }).tone).toBe("ok");
    expect(supplyCheckText({ status: "ok", slot: 1, supplyRaw: "2", matches: false }).tone).toBe("warn");
    expect(supplyCheckText({ status: "unavailable", slot: null, supplyRaw: null, matches: null }).text).toMatch(/^Unavailable/);
    expect(supplyCheckText({ status: "not_applicable", slot: null, supplyRaw: null, matches: null }).tone).toBe("na");
  });
});

import { WEB_RUNNABLE } from "@/lib/product-run";
import { hasWebInterface } from "@/components/mcpx/product-run";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
describe("interface coverage", () => {
  it("every server-runnable template has a website interface and an MCP adapter; Canvas stays MCP-only", () => {
    for (const t of WEB_RUNNABLE) { expect(hasWebInterface(t)).toBe(true); expect(Object.values(ADAPTERS).some((a) => a.templateId === t)).toBe(true); }
    expect(hasWebInterface("canvas")).toBe(false);
    expect(WEB_RUNNABLE).toHaveLength(16);
  });
});
