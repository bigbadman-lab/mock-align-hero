// Test-only fault injection: a registry backend that never answers until aborted.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => {
  const builder: Record<string, unknown> = {};
  let signal: AbortSignal | undefined;
  for (const m of ["from", "select", "order", "range"]) builder[m] = () => builder;
  builder["abortSignal"] = (s: AbortSignal) => { signal = s; return builder; };
  builder["then"] = (_ok: unknown, fail: (e: unknown) => void) =>
    new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("AbortError: signal is aborted")))).catch(fail);
  return { supabase: builder };
});

import { fetchVerifiedCreations, REGISTRY_TIMEOUT_MS } from "@/lib/registry";

describe("registry timeout", () => {
  it("ceiling is 10 seconds", () => expect(REGISTRY_TIMEOUT_MS).toBe(10_000));
  it("an aborted/timed-out read settles as unavailable, never as empty", async () => {
    const c = new AbortController();
    const p = fetchVerifiedCreations(0, c.signal);
    setTimeout(() => c.abort(), 20);
    const r = await p;
    expect(r.status).toBe("unavailable");
    expect("items" in r).toBe(false);
  });
});
