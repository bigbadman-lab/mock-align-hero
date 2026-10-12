// Wallet SDK code calls the global `Buffer` (e.g. Buffer.from) and browsers have none.
// This is an explicit function (not a bare side-effect import) because package.json
// declares "sideEffects": false, which lets the production bundler drop side-effect-only modules.
import { Buffer } from "buffer";

export function installBufferPolyfill(): void {
  const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
  if (!g.Buffer) g.Buffer = Buffer;
}
