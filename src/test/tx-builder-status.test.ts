import { describe, it, expect, afterEach, vi } from "vitest";
import { getBuilderStatus } from "@/lib/tx-builder/status.server";
import { interpretReady } from "@/lib/tx-builder/contract";

afterEach(() => vi.unstubAllEnvs());

describe("transaction builder status (04-A)", () => {
  it("reports BUILDER_NOT_DEPLOYED when no builder URL is configured", async () => {
    vi.stubEnv("MCPX_TX_BUILDER_URL", "");
    expect(await getBuilderStatus()).toEqual({ state: "BUILDER_NOT_DEPLOYED" });
  });
  it("reports unreachable on network failure, never ready", async () => {
    vi.stubEnv("MCPX_TX_BUILDER_URL", "https://builder.example");
    const f = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await getBuilderStatus(f)).toEqual({ state: "BUILDER_UNREACHABLE" });
  });
  it("a ready builder without $MCP mint still reports QUOTE_MINT_MISSING and never launch-enabled", () => {
    expect(interpretReady({ ready: true, quoteMint: "QUOTE_MINT_MISSING", launchEnabled: true })).toEqual({ state: "BUILDER_READY_FOR_PREPARE", quoteMint: "QUOTE_MINT_MISSING", launchEnabled: false });
  });
});
