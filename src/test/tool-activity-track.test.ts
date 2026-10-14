import { describe, expect, it, vi } from "vitest";
import { track } from "@/lib/mcp-gateway/server";

describe("tool activity recording", () => {
  it("records one event with a fresh execution ref", async () => {
    const rec = vi.fn(async (_e: unknown) => {});
    await track(rec, "c1", "token_scanner", "error");
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec.mock.calls[0]![0]).toMatchObject({ creationId: "c1", toolId: "token_scanner", outcome: "error" });
  });
  it("a failing recorder never throws into the tool call and is not retried", async () => {
    const rec = vi.fn(async () => { throw new Error("db down"); });
    await expect(track(rec, "c1", "token_scanner", "ok")).resolves.toBeUndefined();
    expect(rec).toHaveBeenCalledTimes(1);
  });
  it("no recorder (tracking off / platform demo) → nothing recorded", async () => {
    await expect(track(undefined, "c1", "token_scanner", "ok")).resolves.toBeUndefined();
  });
});
