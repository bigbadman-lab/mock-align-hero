// Server-side pixel decoding for token artwork (Phase 04-E correction).
// Runs AFTER checkImage() (structure, signature, size, 1:1, 64–4096, no animation), so no decoder ever
// sees a file whose header claims more than 4096×4096 pixels.
//  - JPEG: libjpeg (mozjpeg) via @jsquash/jpeg, WebAssembly.
//  - WebP: libwebp via @jsquash/webp, WebAssembly.
//  - PNG:  platform zlib (DecompressionStream) streaming inflate with a hard output cap, plus per-row
//          filter-byte validation — a full PNG decode minus colour conversion (see image.ts).
// The decoded size must equal the header size exactly, otherwise the file is rejected.
// WebAssembly modules are imported as precompiled modules (`?module`) because the deployed worker
// runtime forbids compiling WebAssembly from bytes at request time.
import type { ImageCheck } from "./image";

type Decoder = (buf: ArrayBuffer) => Promise<{ width: number; height: number; data: { length: number } }>;
// libjpeg reports recoverable corruption (e.g. "premature end of data segment") as warnings and still
// returns pixels; any decoder diagnostic during a decode fails the file. Decodes are synchronous inside
// the codec, so one flag per call is race-free.
let diagnostics = 0;
const opts = { print: () => { diagnostics++; }, printErr: () => { diagnostics++; } };
type Init = (m?: unknown, o?: unknown) => Promise<void>;
const cache: Partial<Record<"jpeg" | "webp", Promise<Decoder>>> = {};

async function precompiled(load: () => Promise<{ default: unknown }>, devPath: string): Promise<WebAssembly.Module> {
  try {
    const m = (await load()).default;
    if (m instanceof WebAssembly.Module) return m;
  } catch { /* dev server / tests run on Node, where `?module` isn't available */ }
  // Node-only fallback (never reached in the deployed bundle, where the import above is a real module).
  const fs = await import("node:fs/promises");
  return WebAssembly.compile(await fs.readFile(`${process.cwd()}/node_modules/${devPath}`));
}

function decoder(kind: "jpeg" | "webp"): Promise<Decoder> {
  return (cache[kind] ??= (async () => {
    if (kind === "jpeg") {
      const lib = await import("@jsquash/jpeg/decode");
      // @ts-expect-error -- wasm module import resolved by the server bundler
      const mod = await precompiled(() => import("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?module"), "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm");
      await (lib.init as unknown as Init)(mod, opts);
      return (b) => lib.default(b);
    }
    const lib = await import("@jsquash/webp/decode");
    // @ts-expect-error -- wasm module import resolved by the server bundler
    const mod = await precompiled(() => import("@jsquash/webp/codec/dec/webp_dec.wasm?module"), "@jsquash/webp/codec/dec/webp_dec.wasm");
    await (lib.init as unknown as Init)(mod, opts);
    return (b) => lib.default(b);
  })().catch((e) => { delete cache[kind]; throw e; }));
}

/** Fully decode the pixels and require they match the already-validated header. */
export async function decodeArtwork(bytes: Uint8Array, checked: Extract<ImageCheck, { ok: true }>): Promise<ImageCheck> {
  if (checked.type === "image/png") return checked; // PNG pixel data is fully inflated + row-validated in checkImage
  const bad: ImageCheck = { ok: false, error: checked.type === "image/jpeg" ? "The JPEG image data is damaged." : "The WebP image data is damaged." };
  let dec: Decoder;
  try { dec = await decoder(checked.type === "image/jpeg" ? "jpeg" : "webp"); }
  catch { throw new Error("decoder_unavailable"); } // infrastructure fault → 503, never "accepted"
  try {
    const copy = bytes.slice().buffer;
    diagnostics = 0;
    const img = await dec(copy);
    if (diagnostics) { console.error("[decodeArtwork] diagnostics", diagnostics); return bad; }
    if (img.width !== checked.width || img.height !== checked.height) return bad;
    if (img.data.length !== checked.width * checked.height * 4) return bad;
    return checked;
  } catch (e) { console.error("[decodeArtwork]", e); return bad; }
}
