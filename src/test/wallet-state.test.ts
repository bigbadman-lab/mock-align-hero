import { describe, expect, it } from "vitest";
import { deriveWalletStatus, explorerAccountUrl, SOLANA_MAINNET_CAIP } from "@/lib/wallet/state";

// Mocked inputs only; this does not exercise a real wallet provider.
const ADDR = "So11111111111111111111111111111111111111112";

describe("wallet state contract", () => {
  it("connected on mainnet is eligible", () =>
    expect(deriveWalletStatus({ isConnected: true, address: ADDR, caipNetworkId: SOLANA_MAINNET_CAIP })).toBe("connected_mainnet"));
  it("connected on devnet is unsupported", () =>
    expect(deriveWalletStatus({ isConnected: true, address: ADDR, caipNetworkId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })).toBe("connected_unsupported_network"));
  it("unknown network is unsupported, not assumed mainnet", () =>
    expect(deriveWalletStatus({ isConnected: true, address: ADDR, caipNetworkId: undefined })).toBe("connected_unsupported_network"));
  it("disconnected never keeps an address identity", () =>
    expect(deriveWalletStatus({ isConnected: false, address: ADDR, caipNetworkId: SOLANA_MAINNET_CAIP })).toBe("disconnected"));
  it("stalled connecting becomes error", () =>
    expect(deriveWalletStatus({ isConnected: false, providerStatus: "connecting", timedOut: true })).toBe("error"));
  it("explorer link encodes a valid address only", () => {
    expect(explorerAccountUrl(ADDR)).toBe(`https://solscan.io/account/${ADDR}`);
    expect(explorerAccountUrl("bad/../x")).toBeNull();
  });
});
