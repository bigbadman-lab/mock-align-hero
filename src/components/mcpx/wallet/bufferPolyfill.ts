// Must be imported BEFORE any @reown/@solana module: their production bundles
// read `Buffer.from` at module init, and browsers have no global Buffer.
import { Buffer } from "buffer";

declare global {
  interface Window {
    Buffer?: typeof Buffer;
  }
}

if (typeof window !== "undefined" && !window.Buffer) {
  window.Buffer = Buffer;
}
