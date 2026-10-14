import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isGatewayUrl, gatewayUrl, pinBytes } from "@/lib/launch/pinata.server";

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

describe("pinata", () => {
  beforeEach(() => { process.env["PINATA_JWT"] = "test"; delete process.env["MCPX_PINATA"]; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env["PINATA_JWT"]; });

  it("uses the dedicated gateway for public URLs", () => {
    expect(gatewayUrl(CID)).toBe(`https://white-acute-buzzard-685.mypinata.cloud/ipfs/${CID}`);
  });
  it("accepts only our gateway with a bare CID", () => {
    expect(isGatewayUrl(gatewayUrl(CID))).toBe(true);
    expect(isGatewayUrl(`https://other.mypinata.cloud/ipfs/${CID}`)).toBe(false);
    expect(isGatewayUrl(`${gatewayUrl(CID)}?x=1`)).toBe(false);
    expect(isGatewayUrl(`http://white-acute-buzzard-685.mypinata.cloud/ipfs/${CID}`)).toBe(false);
  });
  it("falls back (null) when Pinata fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await pinBytes(new Uint8Array([1]), "a.png", "image/png")).toBeNull();
  });
  it("returns the gateway URL on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { cid: CID } }), { status: 200 })));
    expect(await pinBytes(new Uint8Array([1]), "a.png", "image/png")).toBe(gatewayUrl(CID));
  });
  it("is off when the kill switch is set", async () => {
    process.env["MCPX_PINATA"] = "0";
    expect(await pinBytes(new Uint8Array([1]), "a.png", "image/png")).toBeNull();
  });
});
