import { describe, it, expect } from "vitest";
import { fetchSiteState, SITE_STATE_TIMEOUT_MS } from "./site-state";

const bridge = { siteUrl: "https://x", secret: "s".repeat(32) };
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

describe("fetchSiteState", () => {
  it("uses a 15 s bound, not the 120 s bridge default", async () => {
    let seen = 0;
    await fetchSiteState(bridge, async (c) => { seen = c.timeoutMs!; return { ok: 1 }; });
    expect(seen).toBe(SITE_STATE_TIMEOUT_MS);
    expect(SITE_STATE_TIMEOUT_MS).toBe(15_000);
  });
  it("recovers from one transient timeout", async () => {
    let n = 0;
    const r = await fetchSiteState(bridge, async () => { if (n++ === 0) throw timeout(); return { schemaReady: true }; });
    expect(r).toEqual({ schemaReady: true });
    expect(n).toBe(2);
  });
  it("persistent timeout throws (never an empty config)", async () => {
    let n = 0;
    await expect(fetchSiteState(bridge, async () => { n++; throw timeout(); })).rejects.toThrow("aborted due to timeout");
    expect(n).toBe(2);
  });
});
