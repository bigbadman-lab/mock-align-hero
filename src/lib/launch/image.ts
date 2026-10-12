// Token artwork validation (Phase 04-E). Pure and browser-safe; the server runs the same checks before
// anything is stored. Identification is by file signature and structure — never by extension or MIME.
//
// Depth of server checking (documented limitation):
//  - PNG: every chunk CRC-checked, APNG rejected, image data fully inflated with a hard output cap and
//    required to equal exactly the size implied by the header (decompression bombs and truncation fail).
//    Every scanline's filter byte is validated while streaming.
//  - JPEG / WebP: container and every segment/chunk walked, frame dimensions read, animation rejected,
//    truncation and trailing data rejected. The server then fully decodes the pixels with libjpeg /
//    libwebp (decode.server.ts) and requires the decoded size to match the header.

export const IMAGE_MAX_BYTES = 5_000_000; // decimal 5 MB
export const IMAGE_MIN_SIDE = 64;
export const IMAGE_MAX_SIDE = 4096; // ≤ 16,777,216 pixels decoded
export type ImageType = "image/png" | "image/jpeg" | "image/webp";
export const IMAGE_EXT: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export type ImageCheck = { ok: true; type: ImageType; width: number; height: number } | { ok: false; error: string };
const no = (error: string): ImageCheck => ({ ok: false, error });

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const le32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const le24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

let CRC: Uint32Array | null = null;
function crc32(b: Uint8Array, s: number, e: number) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = s; i < e; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sniff(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && u32(b, 0) === 0x89504e47 && u32(b, 4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

function dims(type: ImageType, width: number, height: number): ImageCheck {
  if (!width || !height) return no("The image has no size.");
  if (width !== height) return no(`Artwork must be exactly square (1:1). This image is ${width}×${height}.`);
  if (width < IMAGE_MIN_SIDE) return no(`Artwork must be at least ${IMAGE_MIN_SIDE}×${IMAGE_MIN_SIDE} pixels.`);
  if (width > IMAGE_MAX_SIDE) return no(`Artwork can be at most ${IMAGE_MAX_SIDE}×${IMAGE_MAX_SIDE} pixels.`);
  return { ok: true, type, width, height };
}

/** Streams zlib output with a hard cap; every scanline must start with a valid PNG filter type (0–4). */
async function inflateExact(data: Uint8Array, expected: number, rows: Array<[number, number]>): Promise<boolean> {
  const ds = new DecompressionStream("deflate");
  const w = ds.writable.getWriter();
  void w.write(data as unknown as BufferSource).then(() => w.close()).catch(() => {});
  const r = ds.readable.getReader();
  let total = 0, ri = 0, left = rows[0]?.[1] ?? 0, next = 0;
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      if (total + value.byteLength > expected) { await r.cancel().catch(() => {}); return false; }
      for (let i = 0; i < value.byteLength; i++, total++) {
        if (total === next) {
          if (value[i]! > 4) { await r.cancel().catch(() => {}); return false; }
          if (--left === 0) { ri++; left = rows[ri]?.[1] ?? 0; }
          next += rows[ri]?.[0] ?? 0;
        }
      }
    }
  } catch { return false; }
  return total === expected;
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

async function checkPng(b: Uint8Array): Promise<ImageCheck> {
  let o = 8, w = 0, h = 0, bits = 0, interlace = 0, seenIdat = false, idatDone = false, end = false;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (o < b.length) {
    if (o + 12 > b.length) return no("The PNG file is cut off.");
    const len = u32(b, o), type = ascii(b, o + 4, 4);
    if (len > b.length || o + 12 + len > b.length) return no("The PNG file is cut off.");
    if (crc32(b, o + 4, o + 8 + len) !== u32(b, o + 8 + len)) return no("The PNG file is damaged.");
    const d = o + 8;
    if (o === 8) {
      if (type !== "IHDR" || len !== 13) return no("The PNG file is damaged.");
      w = u32(b, d); h = u32(b, d + 4);
      const depth = b[d + 8]!, color = b[d + 9]!;
      interlace = b[d + 12]!;
      if (!PNG_DEPTHS[color]?.includes(depth) || b[d + 10] !== 0 || b[d + 11] !== 0 || interlace > 1) return no("The PNG file is damaged.");
      bits = depth * PNG_CHANNELS[color]!;
      const sized = dims("image/png", w, h);
      if (!sized.ok) return sized;
    } else if (type === "IHDR") return no("The PNG file is damaged.");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return no("Animated images aren't allowed.");
    if (type === "IDAT") {
      if (idatDone) return no("The PNG file is damaged.");
      seenIdat = true; idat.push(b.subarray(d, d + len)); idatLen += len;
    } else if (seenIdat) idatDone = true;
    o += 12 + len;
    if (type === "IEND") { end = true; break; }
  }
  if (!end) return no("The PNG file is cut off.");
  if (o !== b.length) return no("The PNG file has extra data after the image.");
  if (!seenIdat) return no("The PNG file has no image data.");
  const row = (pw: number) => 1 + Math.ceil((pw * bits) / 8);
  let expected = 0;
  const rows: Array<[number, number]> = [];
  if (!interlace) { expected = h * row(w); rows.push([row(w), h]); }
  else for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw > 0 && ph > 0) { expected += ph * row(pw); rows.push([row(pw), ph]); }
  }
  const all = new Uint8Array(idatLen);
  let p = 0;
  for (const c of idat) { all.set(c, p); p += c.length; }
  if (!(await inflateExact(all, expected, rows))) return no("The PNG image data is damaged or doesn't match its size.");
  return dims("image/png", w, h);
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function checkJpeg(b: Uint8Array): ImageCheck {
  let o = 2, w = 0, h = 0, frames = 0, scans = 0;
  for (;;) {
    if (o + 2 > b.length) return no("The JPEG file is cut off.");
    if (b[o] !== 0xff) return no("The JPEG file is damaged.");
    let m = b[o + 1]!;
    while (m === 0xff && o + 2 < b.length) { o++; m = b[o + 1]!; }
    o += 2;
    if (m === 0xd9) break; // EOI
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) return no("The JPEG file is damaged.");
    if (o + 2 > b.length) return no("The JPEG file is cut off.");
    const len = u16(b, o);
    if (len < 2 || o + len > b.length) return no("The JPEG file is cut off.");
    if (SOF.has(m)) {
      if (len < 8) return no("The JPEG file is damaged.");
      frames++; h = u16(b, o + 3); w = u16(b, o + 5);
      const sized = dims("image/jpeg", w, h);
      if (!sized.ok) return sized;
    }
    o += len;
    if (m === 0xda) {
      if (!frames) return no("The JPEG file is damaged.");
      scans++;
      // Skip entropy-coded data up to the next real marker.
      while (o + 1 < b.length && !(b[o] === 0xff && b[o + 1] !== 0x00 && !(b[o + 1]! >= 0xd0 && b[o + 1]! <= 0xd7))) o++;
      if (o + 1 >= b.length) return no("The JPEG file is cut off.");
    }
  }
  if (frames !== 1 || !scans) return no("The JPEG file is damaged.");
  if (o !== b.length) return no("The JPEG file has extra data after the image.");
  return dims("image/jpeg", w, h);
}

function checkWebp(b: Uint8Array): ImageCheck {
  if (le32(b, 4) + 8 !== b.length) return no("The WebP file is cut off or has extra data.");
  let o = 12, w = 0, h = 0, image = 0;
  while (o < b.length) {
    if (o + 8 > b.length) return no("The WebP file is cut off.");
    const type = ascii(b, o, 4), len = le32(b, o + 4), d = o + 8;
    if (d + len > b.length) return no("The WebP file is cut off.");
    if (type === "ANIM" || type === "ANMF") return no("Animated images aren't allowed.");
    if (type === "VP8X") {
      if (o !== 12 || len < 10) return no("The WebP file is damaged.");
      if (b[d]! & 0x02) return no("Animated images aren't allowed.");
      w = le24(b, d + 4) + 1; h = le24(b, d + 7) + 1;
    } else if (type === "VP8 ") {
      if (len < 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return no("The WebP file is damaged.");
      const fw = (b[d + 6]! | (b[d + 7]! << 8)) & 0x3fff, fh = (b[d + 8]! | (b[d + 9]! << 8)) & 0x3fff;
      if (w && (fw !== w || fh !== h)) return no("The WebP file is inconsistent.");
      w = fw; h = fh; image++;
    } else if (type === "VP8L") {
      if (len < 5 || b[d] !== 0x2f) return no("The WebP file is damaged.");
      const bits = le32(b, d + 1);
      const fw = (bits & 0x3fff) + 1, fh = ((bits >>> 14) & 0x3fff) + 1;
      if (w && (fw !== w || fh !== h)) return no("The WebP file is inconsistent.");
      w = fw; h = fh; image++;
    }
    o = d + len + (len & 1);
  }
  if (o !== b.length) return no("The WebP file is damaged.");
  if (image !== 1) return no("The WebP file has no single still image.");
  return dims("image/webp", w, h);
}

/** Full structural check. Size bound first so nothing large is parsed. */
export async function checkImage(b: Uint8Array): Promise<ImageCheck> {
  if (b.length === 0) return no("The file is empty.");
  if (b.length > IMAGE_MAX_BYTES) return no("Artwork must be 5 MB or smaller (5,000,000 bytes).");
  const t = sniff(b);
  if (!t) return no("Only PNG, JPEG or WebP images are allowed.");
  try {
    if (t === "image/png") return await checkPng(b);
    if (t === "image/jpeg") return checkJpeg(b);
    return checkWebp(b);
  } catch { return no("The image could not be read."); }
}

export const sha256Hex = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
