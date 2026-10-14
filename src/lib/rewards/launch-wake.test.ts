import { describe, expect, it } from "vitest";
import { shouldWake, waitForLaunch } from "../../../services/rewards-worker/src/launch-wake";

const iso = (t: number) => new Date(t).toISOString();

describe("launch wake", () => {
  it("wakes for a claim newer than the last pass", () => {
    expect(shouldWake({ pending: 1, newestCreatedAt: iso(10_000) }, 12_000, 5_000)).toBe(true);
  });
  it("does not wake with no pending claims", () => {
    expect(shouldWake({ pending: 0, newestCreatedAt: null }, 12_000, 5_000)).toBe(false);
  });
  it("retries a fresh claim no more than every 15 s", () => {
    expect(shouldWake({ pending: 1, newestCreatedAt: iso(0) }, 10_000, 1_000)).toBe(false);
    expect(shouldWake({ pending: 1, newestCreatedAt: iso(0) }, 16_000, 1_000)).toBe(true);
  });
  it("ignores claims older than 3 minutes (normal poll handles them)", () => {
    expect(shouldWake({ pending: 1, newestCreatedAt: iso(0) }, 181_000, 100_000)).toBe(false);
  });
  it("a failed check never wakes; times out at maxMs", async () => {
    let t = 0;
    const r = await waitForLaunch({ maxMs: 20_000, lastPassAt: 0, stopping: () => false, now: () => t,
      sleep: async (ms) => { t += ms; }, check: async () => { throw new Error("down"); } });
    expect(r).toBe("timeout");
  });
  it("wakes within one 5 s check after a new launch", async () => {
    let t = 0;
    const r = await waitForLaunch({ maxMs: 60_000, lastPassAt: 0, stopping: () => false, now: () => t,
      sleep: async (ms) => { t += ms; }, check: async () => ({ pending: 1, newestCreatedAt: iso(3_000) }) });
    expect(r).toBe("woken"); expect(t).toBe(5_000);
  });
});
