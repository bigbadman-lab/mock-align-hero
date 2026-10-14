import { describe, expect, it } from "vitest";
import { claimOutcome, launchBlocker } from "@/lib/launch/launch-flow";

const W = "2ZrpSo3SmuKnFG69XMEYv2Ew54oKGB2DXPVBAJHBGYx2";
const ok = { serverEnabled: true, signedInWallet: W, connectedWallet: W, metadataReady: true };

describe("launch button", () => {
  it("stays closed while the server has launching switched off", () => {
    expect(launchBlocker({ ...ok, serverEnabled: false })).toBe("launch_closed");
  });
  it("needs a creator sign-in", () => expect(launchBlocker({ ...ok, signedInWallet: null })).toBe("sign_in"));
  it("refuses a connected wallet different from the signed-in one", () => {
    expect(launchBlocker({ ...ok, connectedWallet: "CqaJhS4BKK791cv2fSsbbc75difqCrTiwkzeeR8WqJVB" })).toBe("wallet_mismatch");
  });
  it("is enabled only when everything is ready", () => expect(launchBlocker(ok)).toBeNull());
});

describe("live link", () => {
  it("appears only for a verified claim with a product page", () => {
    expect(claimOutcome({ status: "VERIFIED", slug: "my-tool" })).toBe("live");
    expect(claimOutcome({ status: "VERIFIED", slug: null })).toBe("pending");
    expect(claimOutcome({ status: "PENDING", slug: "my-tool" })).toBe("pending");
    expect(claimOutcome({ status: "REJECTED" })).toBe("rejected");
  });
});
