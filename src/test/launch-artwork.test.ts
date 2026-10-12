import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { IMAGE_MAX_BYTES, checkImage } from "@/lib/launch/image";
import { buildMetadata, checkUri } from "@/lib/launch/metadata";
import { canTransition, recoveryMint, statusAfterEdit } from "@/lib/launch/lifecycle";
import { parseDraftBody } from "@/lib/launch/drafts-core";

const fx = (n: string) => new Uint8Array(readFileSync(`src/test/fixtures/images/${n}`));

let T: Uint32Array | null = null;
function crc(b: Uint8Array) {
  if (!T) { T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } }
  let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out;
}
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, b) => a + b.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
function png(w: number, h: number, raw: Uint8Array, pad = 0) {
  const ih = new Uint8Array(13); const dv = new DataView(ih.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ih[8] = 8; ih[9] = 2;
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ih), chunk("IDAT", new Uint8Array(deflateSync(raw)))];
  if (pad) parts.push(chunk("prVt", new Uint8Array(pad)));
  return cat(...parts, chunk("IEND", new Uint8Array()));
}

describe("artwork validation (same checks run on the server)", () => {
  it("accepts square PNG and JPEG with their real sizes; refuses WebP", async () => {
    for (const [f, t] of [["sq.png", "image/png"], ["sq.jpg", "image/jpeg"]] as const)
      expect(await checkImage(fx(f))).toEqual({ ok: true, type: t, width: 256, height: 256 });
    for (const f of ["sq.webp", "sq-lossless.webp"]) expect(await checkImage(fx(f))).toMatchObject({ ok: false, error: expect.stringContaining("WebP") });
  });
  it("accepts a valid PNG of exactly 5,000,000 bytes and rejects 5,000,001", async () => {
    const raw = new Uint8Array(64 * (1 + 64 * 3));
    const base = png(64, 64, raw).length;
    const exact = png(64, 64, raw, IMAGE_MAX_BYTES - base - 12);
    expect(exact.length).toBe(5_000_000);
    expect((await checkImage(exact)).ok).toBe(true);
    const over = png(64, 64, raw, IMAGE_MAX_BYTES - base - 11);
    expect(over.length).toBe(5_000_001);
    expect(await checkImage(over)).toMatchObject({ ok: false, error: expect.stringContaining("5 MB") });
  });
  it("rejects non-square, GIF, SVG, animated WebP, empty and spoofed files", async () => {
    expect(await checkImage(fx("wide.png"))).toMatchObject({ ok: false, error: expect.stringContaining("300×200") });
    expect((await checkImage(fx("sq.gif"))).ok).toBe(false);
    expect((await checkImage(fx("x.svg"))).ok).toBe(false);
    expect((await checkImage(fx("anim.webp"))).ok).toBe(false);
    expect((await checkImage(new Uint8Array()))).toMatchObject({ ok: false });
    expect((await checkImage(cat(new TextEncoder().encode("<html>"), fx("sq.png"))))).toMatchObject({ ok: false });
  });
  it("rejects truncated or damaged files", async () => {
    for (const f of ["sq.png", "sq.jpg"]) {
      const b = fx(f);
      expect((await checkImage(b.subarray(0, b.length - 20))).ok).toBe(false);
    }
    const bad = fx("sq.png").slice(); bad[40] = bad[40]! ^ 0xff;
    expect((await checkImage(bad)).ok).toBe(false);
  });
  it("rejects a decompression bomb whose data inflates past its header size", async () => {
    const bomb = png(64, 64, new Uint8Array(20_000_000));
    expect(bomb.length).toBeLessThan(IMAGE_MAX_BYTES);
    expect(await checkImage(bomb)).toMatchObject({ ok: false });
    expect(await checkImage(png(5000, 5000, new Uint8Array(10)))).toMatchObject({ ok: false, error: expect.stringContaining("4096") });
  });
});

describe("canonical metadata", () => {
  const d = { tokenName: "Whale \"Watch\"", symbol: "WHALE", description: "Line1\nLine2 <b>", link: "https://example.org/" };
  it("contains only the token fields, in a fixed order, safely escaped", () => {
    const { json, meta } = buildMetadata(d, "https://mcpx.fun/api/public/launch-assets/artwork/0b3f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png");
    expect(Object.keys(meta)).toEqual(["name", "symbol", "description", "image", "showName", "website"]);
    expect(JSON.parse(json)).toEqual(meta);
    expect(json).not.toMatch(/wallet|fee|supply|creator/i);
  });
  it("omits website when there is no link, and refuses a non-https image", () => {
    expect(Object.keys(buildMetadata({ ...d, link: null }, "https://a.b/c.png").meta)).not.toContain("website");
    expect(() => buildMetadata(d, "http://a.b/c.png")).toThrow();
  });
  it("blocks a metadata URL over the builder's 200-character uri limit instead of truncating", () => {
    expect(checkUri("https://mcpx.fun/" + "a".repeat(183))).toEqual({ ok: true });
    expect(checkUri("https://mcpx.fun/" + "a".repeat(184))).toEqual({ ok: false, error: "URI_TOO_LONG" });
  });
});

describe("lifecycle safeguards", () => {
  it("can't reach on-chain states without a signature, mint and proof", () => {
    expect(canTransition("AWAITING_SIGNATURES", "SUBMITTED", {})).toBe(false);
    expect(canTransition("SUBMITTED", "CONFIRMED", { signature: "s", mint: "m" })).toBe(false);
    expect(canTransition("CONFIRMED", "FEE_VERIFIED", { signature: "s", mint: "m", chainProof: {} })).toBe(true);
    expect(canTransition("PREPARED_UNSIGNED", "FEE_VERIFIED", { signature: "s", mint: "m", chainProof: {} })).toBe(false);
  });
  it("an uncertain outcome never becomes 'nothing happened' and always reuses the mint", () => {
    expect(canTransition("UNKNOWN_OUTCOME", "EXPIRED", {})).toBe(false);
    expect(recoveryMint({ state: "UNKNOWN_OUTCOME", mint: "M1" })).toEqual({ reuse: "M1" });
    expect(recoveryMint({ state: "SUBMITTED", mint: "M1" })).toEqual({ reuse: "M1" });
    expect(recoveryMint({ state: "AWAITING_SIGNATURES", mint: "M1" })).toEqual({ blocked: true });
  });
  it("any edit drops metadata", () => {
    expect(statusAfterEdit(true)).toBe("ARTWORK_SAVED");
    expect(statusAfterEdit(false)).toBe("DRAFT");
  });
});

describe("draft request parsing", () => {
  const draft = { templateId: "wallet-inspector", settings: {}, productName: "P", tokenName: "T", symbol: "T1", description: "d", link: "", buyEnabled: false, buyAmount: "", slippageBps: "100" };
  it("never accepts a wallet, owner or fee field from the browser", () => {
    expect(parseDraftBody({ action: "create", createKey: "a".repeat(16), draft, wallet: "x" })).toEqual({ error: "invalid_input" });
    expect(parseDraftBody({ action: "create", createKey: "a".repeat(16), draft: { ...draft, feeRecipient: "x" } })).toEqual({ error: "invalid_input" });
    expect(parseDraftBody({ action: "create", createKey: "a".repeat(16), draft })).toMatchObject({ action: "create" });
  });
  it("requires a revision for updates", () => {
    expect(parseDraftBody({ action: "update", id: "0b3f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", draft })).toEqual({ error: "invalid_input" });
  });
});
