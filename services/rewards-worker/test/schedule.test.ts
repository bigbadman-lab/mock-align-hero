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
  it("floors at 60 s when the natural wait is shorter (no hot loop)", () => {
    expect(nextBoundaryDelayMs(25_000)).toBe(60_000); // natural 5 s → floored
    expect(nextBoundaryDelayMs(0)).toBe(60_000); // natural 30 s → floored
  });
  it("never exceeds one window plus the offset and never goes below 60 s", () => {
    for (const t of [0, 1, 29_999, 30_000, 30_001, 150_000, 299_999, 600_000, 123_456_789]) {
      const d = nextBoundaryDelayMs(t);
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(W + OFF);
    }
  });
  it("fires 30 s past a boundary whenever the 60 s floor does not apply", () => {
    for (const t of [30_001, 60_000, 150_000, 270_000, 123_456_789]) {
      expect((t + nextBoundaryDelayMs(t)) % W).toBe(OFF);
    }
  });
});
