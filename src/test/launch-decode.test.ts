import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkImage } from "@/lib/launch/image";
import { decodeArtwork } from "@/lib/launch/decode.server";

const F = (n: string) => new Uint8Array(readFileSync(`${__dirname}/fixtures/images/${n}`));
async function full(b: Uint8Array) {
  const c = await checkImage(b);
  return c.ok ? decodeArtwork(b, c) : c;
}

describe("server artwork decoding", () => {
  it("decodes real PNG and JPEG; refuses WebP", async () => {
    expect(await full(F("sq.webp"))).toMatchObject({ ok: false, error: expect.stringContaining("WebP") });
    for (const n of ["sq.png", "sq.jpg"]) expect((await full(F(n))).ok, n).toBe(true);
  });
  it("rejects JPEG whose pixel data is corrupted but structure is intact", async () => {
    const j = F("sq.jpg");
    for (let i = j.length - 300; i < j.length - 10; i++) if (j[i] !== 0xff && j[i - 1] !== 0xff) j[i] = 0;
    expect(await full(j)).toMatchObject({ ok: false });
  });
  it("rejects a PNG decompression bomb and invalid row filters", async () => {
    expect(await full(F("bomb.png"))).toMatchObject({ ok: false });
    expect(await full(F("badfilter.png"))).toMatchObject({ ok: false });
  });
  it("rejects non-square JPEG and JPEG over 2048 px", async () => {
    expect(await full(F("wide.jpg"))).toMatchObject({ ok: false, error: expect.stringContaining("square") });
    expect(await full(F("j2049.jpg"))).toMatchObject({ ok: false, error: expect.stringContaining("2048") });
  });
  it("decodes a 2048 px progressive JPEG within the memory cap", async () => {
    expect((await full(F("j2048.jpg"))).ok).toBe(true);
  });
});
