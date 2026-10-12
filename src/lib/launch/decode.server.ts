// Server-side pixel decoding for token artwork (Phase 04-E correction).
// Runs AFTER checkImage() (signature, size, 1:1, 64–4096, no animation), so no decoder ever sees a file
// whose header claims more than 4096×4096 pixels.
//  - PNG:  platform zlib streaming inflate with a hard output cap + per-row filter validation (image.ts).
//  - JPEG: jpeg-js (pure JavaScript, no WebAssembly — the deployed runtime can't load WASM from the
//          server bundle). Strict mode (no tolerant decoding), resolution and memory caps enforced by
//          the decoder itself; decoded size must equal the header.
//  - WebP: not accepted (no server decoder without WebAssembly on this stack).
import jpeg from "jpeg-js";
import type { ImageCheck } from "./image";

const MAX_MP = 4.2; // JPEG_MAX_SIDE 2048² ≈ 4.19 MP
const MAX_MEM_MB = 64; // measured: a 2048² progressive JPEG needs ~56 MB; stays well under the worker limit

export async function decodeArtwork(bytes: Uint8Array, checked: Extract<ImageCheck, { ok: true }>): Promise<ImageCheck> {
  if (checked.type !== "image/jpeg") return checked;
  try {
    const img = jpeg.decode(bytes, {
      useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
      maxResolutionInMP: MAX_MP, maxMemoryUsageInMB: MAX_MEM_MB,
    });
    if (img.width !== checked.width || img.height !== checked.height) throw new Error("size");
    if (img.data.length !== checked.width * checked.height * 3) throw new Error("data");
    return checked;
  } catch {
    return { ok: false, error: "The JPEG image data is damaged." };
  }
}
