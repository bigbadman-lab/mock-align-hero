// Server-side pixel decoding for token artwork (Phase 04-E correction).
// Runs AFTER checkImage() (signature, size, 1:1, 64–4096, no animation), so no decoder ever sees a file
// whose header claims more than 4096×4096 pixels.
//  - PNG:  platform zlib streaming inflate with a hard output cap + per-row filter validation (image.ts).
//  - JPEG: jpeg-js (pure JavaScript, no WebAssembly — the deployed runtime can't load WASM from the
//          server bundle). Strict mode (no tolerant decoding), resolution and memory caps enforced by
//          the decoder itself; decoded size must equal the header.
//  - WebP: NO server pixel decoder available without WebAssembly. Structure-only on the server
//          (every chunk walked, VP8/VP8L headers checked, animation rejected); the browser decodes
//          before upload. Documented limitation — see the 04-E report.
import jpeg from "jpeg-js";
import type { ImageCheck } from "./image";

const MAX_MP = 17; // 4096² ≈ 16.8 MP
const MAX_MEM_MB = 96; // RGB output for 4096² is ~48 MB; keeps headroom under the worker memory limit

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
