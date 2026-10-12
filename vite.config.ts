// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { createRequire } from "node:module";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const require = createRequire(import.meta.url);
const BUFFER_PATH = require.resolve("buffer/");
const EVENTS_PATH = require.resolve("events/");

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      {
        // Artwork decoders (src/lib/launch/decode.server.ts) import their WebAssembly as precompiled
        // modules (`*.wasm?module`). The SSR step can't load those; hand the absolute path through so the
        // final server bundler (unwasm) emits it as a real Worker WebAssembly module import. The deployed
        // runtime forbids compiling WebAssembly from bytes, so inlining would fail only after publish.
        name: "mcpx-server-wasm-module",
        enforce: "pre",
        apply: "build",
        async resolveId(id: string, importer?: string) {
          if (this.environment?.name === "client" || !id.endsWith(".wasm?module")) return null;
          const r = await this.resolve(id.slice(0, -"?module".length), importer, { skipSelf: true });
          return r ? { id: `${r.id}?module`, external: true } : null;
        },
      },
      {
        // Wallet SDK deps (safe-buffer, borsh, @solana/*) call require("buffer").Buffer at module init.
        // Without this, production client builds resolve "buffer" to an empty browser stub and crash.
        name: "mcpx-browser-buffer" /* also resolves events */,
        enforce: "pre",
        apply: "build", // dev pre-bundling already handles buffer correctly
        resolveId(id: string) {
          if (this.environment?.name !== "client") return null;
          if (id === "buffer" || id === "buffer/" || id === "node:buffer") return BUFFER_PATH;
          // @walletconnect/* do `import EventEmitter from "events"`; the empty stub breaks the WalletConnect provider.
          if (id === "events" || id === "events/" || id === "node:events") return EVENTS_PATH;
          return null;
        },
      },
    ],
  },
});
