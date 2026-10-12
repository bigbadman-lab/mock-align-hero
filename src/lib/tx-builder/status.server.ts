// Server-only: reads the separate transaction builder's /ready. MCPX_TX_BUILDER_URL is read per call;
// MCPX_TX_BUILDER_SECRET is reserved for signed internal calls and is never sent to the browser.
import { interpretReady, type BuilderStatus } from "./contract";

export async function getBuilderStatus(fetchImpl: typeof fetch = fetch): Promise<BuilderStatus> {
  const url = process.env["MCPX_TX_BUILDER_URL"];
  if (!url || !/^https:\/\//.test(url)) return { state: "BUILDER_NOT_DEPLOYED" };
  try {
    const r = await fetchImpl(new URL("/ready", url), { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { state: "BUILDER_UNHEALTHY" };
    const text = await r.text();
    if (text.length > 16_000) return { state: "BUILDER_MALFORMED" };
    let body: unknown;
    try { body = JSON.parse(text); } catch { return { state: "BUILDER_MALFORMED" }; }
    return interpretReady(body);
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { state: "BUILDER_TIMEOUT" };
    return { state: "BUILDER_UNREACHABLE" };
  }
}
