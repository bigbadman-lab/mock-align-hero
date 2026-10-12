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

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      {
        // Wallet SDK deps (safe-buffer, borsh, @solana/*) call require("buffer").Buffer at module init.
        // Without this, production client builds resolve "buffer" to an empty browser stub and crash.
        name: "mcpx-browser-buffer",
        enforce: "pre",
        resolveId(id: string) {
          if (this.environment?.name !== "client") return null;
          if (id === "buffer" || id === "buffer/" || id === "node:buffer") return BUFFER_PATH;
          return null;
        },
      },
    ],
  },
});
