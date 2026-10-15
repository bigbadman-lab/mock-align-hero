import { describe, expect, it } from "bun:test";
import { nextBoundaryDelayMs } from "../src/schedule";

const W = 300_000; // 5-minute window
const OFF = 30_000; // start each pass 30 s after the boundary

describe("nextBoundaryDelayMs", () => {
  it("lands 30 s after the next boundary from mid-window", () => {
    // 2:00 into a window → 3:30 remaining until boundary+30 s
    expect(nextBoundaryDelayMs(2 * 60_000)).toBe(3 * 60_000 + 30_000);
  });
  it("waits for the following window when already past the offset", () => {
    // 4:00 into a window → next target is next boundary + 30 s = 1:30 away
    expect(nextBoundaryDelayMs(4 * 60_000)).toBe(90_000);
  });
  it("fires almost immediately just before the offset", () => {
    expect(nextBoundaryDelayMs(25_000)).toBe(5_000 < 60_000 ? 60_000 : 5_000); // floored at 60 s
  });
  it("is exact at the boundary itself", () => {
    expect(nextBoundaryDelayMs(0)).toBe(OFF < 60_000 ? 60_000 : OFF);
  });
  it("never exceeds one window plus the offset and never goes below 60 s", () => {
    for (const t of [0, 1, 29_999, 30_000, 30_001, 150_000, 299_999, 600_000, 123_456_789]) {
      const d = nextBoundaryDelayMs(t);
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(W + OFF);
      // The resulting fire time is always 30 s past a boundary.
      expect((t + d) % W).toBe(OFF);
    }
  });
});
