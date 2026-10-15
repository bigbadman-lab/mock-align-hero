// Entertainment & Experimental AI templates — mocked OpenAI only (fixtures live in this file).
import { describe, expect, it } from "vitest";
import { AI_TOOLS, AI_TOOL_BY_TEMPLATE, AI_MAX_HISTORY } from "@/lib/ai-tools/defs";
import { runAiTool, aiAvailability, AI_MAX_CONCURRENT, type AiExecDeps, type AiEnv } from "@/lib/ai-tools/execute";
import { ADAPTERS } from "@/lib/mcp-gateway/registry";
import { LIBRARY, TEMPLATES } from "@/lib/templates";
import { runProductTool } from "@/lib/product-run";

const KEY = "sk-test-SECRET-never-leak";
const env = (o: Partial<AiEnv> = {}): AiEnv => ({ apiKey: KEY, model: "gpt-4o-mini", disabled: false, perMinute: 30, perDay: 2000, ...o });
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
function deps(o: { env?: Partial<AiEnv>; fetch?: typeof fetch; take?: (b: string) => boolean | Promise<boolean> } = {}) {
  const calls = { bodies: [] as Record<string, unknown>[], buckets: [] as string[] };
  const d: AiExecDeps = {
    env: () => env(o.env),
    take: async (b) => { calls.buckets.push(b); return o.take ? o.take(b) : true; },
    fetchImpl: (async (_u: string, init: RequestInit) => { calls.bodies.push(JSON.parse(String(init.body))); return o.fetch ? o.fetch(_u, init) : reply({ reply: "blorp" }); }) as typeof fetch,
  };
  return { d, calls };
}
const OUT: Record<string, unknown> = {
  "gibberish-ai": { reply: "Zorp flibble!" }, "roast-bot": { roast: "Your tabs have tabs." }, "excuse-machine": { excuse: "A goose filed my taxes." },
  "conspiracy-potato": { headline: "Socks Are Spies", theory: "They report to the dryer.", clues: ["lint", "static", "one left"], conclusion: "The dryer knows." },
  "argument-machine": { reply: "Wrong, obviously." },
  "future-you": { timeline: "Writing from 10 years ahead", title: "Keep the guitar", letter: "Dear me, the hoverboards are fine.", advice: "Tune before you tour.", closing_quote: "Rock on." },
  "web3-startup-roulette": { name: "YieldFrog", ticker: "$ribbit", pitch: "Frogs, but on-chain.", problem: "Ponds lack liquidity.", solution: "Tokenised lily pads.", token_utility: "Croaking rights.", tokenomics: ["40% frogs", "60% the founder's cat"], valuation: "$9 quintillion (imaginary)", investor_pitch: "Leap with us.", founder_quote: "Ribbit." },
  "monster-factory": { name: "Kettlowl", species: "Steam owl", appearance: "Feathery spout.", abilities: ["Whistles", "Brews tea", "Hoots"], weakness: "Descaler", personality: "Cosy", habitat: "Kitchens", origin: "Born at 100°C.", rarity: "LEGENDARY", fact: "Prefers oolong." },
  "pigeon-ceo": { opening: "Coo.", recommendation: "Acquire bread.", action_items: ["Peck", "Strut", "Nap"], impact: "Crumbs up 400%", confidence: 9001, closing_quote: "Bread is strategy." },
};
const IN: Record<string, Record<string, unknown>> = {
  "gibberish-ai": { message: "hi", style: "alien" }, "roast-bot": { subject: "my code", intensity: "savage" }, "excuse-machine": { situation: "late", absurdity: 5 },
  "conspiracy-potato": { topic: "socks", style: "unhinged" }, "argument-machine": { message: "sky is blue", personality: "petty" },
  "future-you": { situation: "learning guitar", years_ahead: 10, personality: "wise" }, "web3-startup-roulette": { sector: "DeFi", absurdity: 4 },
  "monster-factory": { ingredient_one: "owl", ingredient_two: "kettle", temperament: "adorable", rarity: "random" },
  "pigeon-ceo": { business_problem: "sales are down", management_style: "clueless", urgency: "boardroom emergency" },
};

describe("catalogue", () => {
  it("library has 20 templates; five AI ones are launchable with MCP adapters, in their own category", () => {
    expect(LIBRARY).toHaveLength(20);
    for (const d of AI_TOOLS.slice(0, 5)) {
      const t = LIBRARY.find((x) => x.id === d.templateId)!;
      expect([t.category, t.toolId, t.mcpAdapter, t.tokenLaunch]).toEqual(["Entertainment & Experimental AI", d.toolId, true, true]);
      expect(TEMPLATES.some((x) => x.id === d.templateId)).toBe(true);
      expect(ADAPTERS[d.templateId]?.engine).toBe("ai");
      expect(ADAPTERS[d.templateId]?.toolName).toBe(d.toolId);
    }
    expect(AI_TOOLS.map((d) => d.toolId)).toEqual(["gibberish_ai", "roast_bot", "excuse_machine", "conspiracy_potato", "argument_machine", "future_you", "web3_startup_roulette", "monster_factory", "pigeon_ceo"]);
  });
  it("four AI Playground templates have MCP adapters but are not launchable until the DB allowlist is migrated", () => {
    for (const id of ["future-you", "web3-startup-roulette", "monster-factory", "pigeon-ceo"]) {
      const t = LIBRARY.find((x) => x.id === id)!;
      expect([t.category, t.mcpAdapter, t.tokenLaunch]).toEqual(["AI Playground", true, false]);
      expect(TEMPLATES.some((x) => x.id === id)).toBe(false);
      expect(ADAPTERS[id]?.engine).toBe("ai");
    }
  });
});

describe("input validation", () => {
  it("accepts each tool's options and rejects bad ones", () => {
    for (const d of AI_TOOLS) expect(d.inputSchema.safeParse(IN[d.templateId]).success).toBe(true);
    const g = AI_TOOL_BY_TEMPLATE["gibberish-ai"]!.inputSchema;
    expect(g.safeParse({ message: "hi", style: "pirate" }).success).toBe(false);
    expect(g.safeParse({ message: "", style: "alien" }).success).toBe(false);
    expect(g.safeParse({ message: "x".repeat(501), style: "alien" }).success).toBe(false);
    expect(g.safeParse({ message: "hi", style: "alien", extra: 1 }).success).toBe(false);
    expect(g.safeParse({ message: "hi", style: "alien", history: Array(AI_MAX_HISTORY + 1).fill({ role: "user", text: "a" }) }).success).toBe(false);
    const e = AI_TOOL_BY_TEMPLATE["excuse-machine"]!.inputSchema;
    expect(e.safeParse({ situation: "x", absurdity: 0 }).success).toBe(false);
    expect(e.safeParse({ situation: "x", absurdity: 6 }).success).toBe(false);
    expect(e.safeParse({ situation: "x", absurdity: 2.5 }).success).toBe(false);
  });
});

describe("execution", () => {
  it("every tool returns a structured result with its schema and options", async () => {
    for (const d of AI_TOOLS) {
      const { d: dp, calls } = deps({ fetch: (async () => reply(OUT[d.templateId])) as never });
      const r = await runAiTool(d, IN[d.templateId]!, dp);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.out["schema"]).toBe(d.schema); expect(r.out["toolId"]).toBe(d.toolId); expect(ADAPTERS[d.templateId]!.validOutput(r.out, {}, {})).toBe(true); }
      expect(calls.bodies[0]!["max_tokens"]).toBe(d.maxOutputTokens);
      expect(calls.bodies[0]!["max_tokens"] as number).toBeLessThanOrEqual(600);
    }
  });
  it("chat history is passed through, bounded", async () => {
    const { d, calls } = deps();
    await runAiTool(AI_TOOL_BY_TEMPLATE["argument-machine"]!, { message: "x", personality: "dramatic", history: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] }, d);
    expect((calls.bodies[0]!["messages"] as unknown[]).length).toBe(4);
  });
  it("malformed model output is never reported as success", async () => {
    const { d } = deps({ fetch: (async () => reply({ wrong: 1 })) as never });
    expect(await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, d)).toEqual({ ok: false, status: 502, error: "bad_response" });
  });
  it("provider errors and timeouts become safe error kinds", async () => {
    const t = deps({ fetch: (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as never });
    expect(await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, t.d)).toMatchObject({ ok: false, error: "timeout" });
    const p = deps({ fetch: (async () => new Response(`{"error":"${KEY}"}`, { status: 401 })) as never });
    const r = await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, p.d);
    expect(r).toEqual({ ok: false, status: 502, error: "provider_error" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it("kill switch and missing key stop execution before any call", async () => {
    for (const e of [{ disabled: true }, { apiKey: undefined }]) {
      const { d, calls } = deps({ env: e });
      expect(await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, d)).toMatchObject({ ok: false, status: 503 });
      expect(calls.bodies).toEqual([]); expect(aiAvailability(d).available).toBe(false);
    }
  });
  it("platform-wide AI spend caps (per minute and per hour, = daily cap / 24) block before calling OpenAI", async () => {
    for (const blocked of ["ai:global:m", "ai:global:h"]) {
      const { d, calls } = deps({ take: (b) => b !== blocked });
      expect(await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, d)).toEqual({ ok: false, status: 429, error: "rate_limited" });
      expect(calls.bodies).toEqual([]);
    }
    const f = deps({ take: () => { throw new Error("db"); } });
    expect(await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, f.d)).toMatchObject({ ok: false, error: "unavailable" }); // fail closed
  });
  it("caps concurrent calls per server", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const { d } = deps({ fetch: (async () => { await gate; return reply({ roast: "x" }); }) as never });
    const def = AI_TOOL_BY_TEMPLATE["roast-bot"]!;
    const running = Array.from({ length: AI_MAX_CONCURRENT }, () => runAiTool(def, IN["roast-bot"]!, d));
    await new Promise((r) => setTimeout(r, 0));
    expect(await runAiTool(def, IN["roast-bot"]!, d)).toEqual({ ok: false, status: 503, error: "busy" });
    release(); await Promise.all(running);
  });
  it("the key goes only in the Authorization header, never in results", async () => {
    let auth = "";
    const { d, calls } = deps({ fetch: (async (_u: string, i: RequestInit) => { auth = new Headers(i.headers).get("authorization") ?? ""; return reply({ roast: "x" }); }) as never });
    const r = await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, d);
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(r)).not.toContain(KEY); expect(JSON.stringify(calls.bodies)).not.toContain(KEY);
  });
});

describe("launched product pages", () => {
  it("run the product's AI tool with the same per-tool free bucket, never the worker", async () => {
    const take: (string | undefined)[] = []; let worker = 0; const runs: string[] = [];
    const out = { schema: "mcpx.ai.roast-bot.v1", toolId: "roast_bot", model: "gpt-4o-mini", roast: "x", intensity: "gentle" };
    const p = { creationId: "c", slug: "s", templateId: "roast-bot", availability: "active", tool: { fixedSettings: [] } } as never;
    const r = await runProductTool({
      resolve: async () => ({ result: { status: "ok", profile: p }, adapter: ADAPTERS["roast-bot"]!, settings: {} }),
      workerConfig: () => ({ url: "https://w", secret: "s".repeat(32) }),
      toolAvailability: async () => { throw new Error("worker must not be asked"); },
      takeShared: async (_c, _r, t) => { take.push(t); return "ok"; },
      callWorker: async () => { worker++; return { ok: false, status: 500, error: "x" }; },
      ai: { available: () => ({ available: true }), run: async (t) => { runs.push(t); return { ok: true, out }; } },
    }, "s", { subject: "me", intensity: "gentle" }, new Request("https://mcpx.fun/x"));
    expect(r.status).toBe(200); expect(take).toEqual(["roast_bot"]); expect(worker).toBe(0); expect(runs).toEqual(["roast-bot"]);
  });
  it("free limit blocks before any AI call", async () => {
    let runs = 0;
    const p = { creationId: "c", slug: "s", templateId: "roast-bot", availability: "active", tool: { fixedSettings: [] } } as never;
    const r = await runProductTool({
      resolve: async () => ({ result: { status: "ok", profile: p }, adapter: ADAPTERS["roast-bot"]!, settings: {} }),
      workerConfig: () => ({ url: "https://w", secret: "s".repeat(32) }), toolAvailability: async () => ({ available: true }) as never,
      takeShared: async () => "free_limit", callWorker: async () => ({ ok: false, status: 500, error: "x" }),
      ai: { available: () => ({ available: true }), run: async () => { runs++; return { ok: false, status: 500, error: "x" }; } },
    }, "s", { subject: "me", intensity: "gentle" }, new Request("https://mcpx.fun/x"));
    expect(r).toEqual({ status: 429, body: { error: "free_limit" } }); expect(runs).toBe(0);
  });
});

describe("limiter windows", () => {
  it("never asks the shared limiter for a window over 1 hour (the database refuses it)", async () => {
    const seen: [string, number, number][] = [];
    const d: AiExecDeps = { env: () => env(), take: async (b, w, l) => { seen.push([b, w, l]); return true; }, fetchImpl: (async () => reply({ roast: "x" })) as never };
    await runAiTool(AI_TOOL_BY_TEMPLATE["roast-bot"]!, IN["roast-bot"]!, d);
    expect(seen).toEqual([["ai:global:m", 60, 30], ["ai:global:h", 3600, 83]]);
  });
});

describe("AI Playground output parsing", () => {
  it("normalises ticker, rarity and clamps confidence", async () => {
    const run = async (id: string) => { const { d } = deps({ fetch: (async () => reply(OUT[id])) as never }); return runAiTool(AI_TOOL_BY_TEMPLATE[id]!, IN[id]!, d); };
    const s = await run("web3-startup-roulette"); expect(s.ok && s.out["ticker"]).toBe("RIBBIT");
    const m = await run("monster-factory"); expect(m.ok && m.out["rarity"]).toBe("legendary");
    const p = await run("pigeon-ceo"); expect(p.ok && p.out["confidence"]).toBe(1000);
  });
  it("rejects bad playground inputs", () => {
    expect(AI_TOOL_BY_TEMPLATE["future-you"]!.inputSchema.safeParse({ situation: "x", years_ahead: 3, personality: "wise" }).success).toBe(false);
    expect(AI_TOOL_BY_TEMPLATE["web3-startup-roulette"]!.inputSchema.safeParse({ sector: "banks", absurdity: 3 }).success).toBe(false);
    expect(AI_TOOL_BY_TEMPLATE["monster-factory"]!.inputSchema.safeParse({ ingredient_one: "owl", temperament: "adorable", rarity: "rare" }).success).toBe(false);
    expect(AI_TOOL_BY_TEMPLATE["pigeon-ceo"]!.inputSchema.safeParse({ business_problem: "x", management_style: "visionary", urgency: "panic" }).success).toBe(false);
  });
});
