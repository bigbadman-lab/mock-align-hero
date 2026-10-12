// Launch readiness bridge: GET-only, no input, returns an allowlisted, redacted list.
// Never forwards builder URLs, secrets, recipients, payloads or transactions. Cached briefly per instance.
import { createServerFn } from "@tanstack/react-start";
import { serverReadiness, type ReadinessItem } from "./readiness";

let cache: { at: number; items: ReadinessItem[] } | null = null;
const TTL_MS = 30_000;

export const getLaunchReadiness = createServerFn({ method: "GET" }).handler(async (): Promise<{ checkedAt: string; items: ReadinessItem[] }> => {
  const now = Date.now();
  if (!cache || now - cache.at > TTL_MS) {
    const { getBuilderStatus } = await import("@/lib/tx-builder/status.server");
    cache = { at: now, items: serverReadiness(await getBuilderStatus()) };
  }
  return { checkedAt: new Date(cache.at).toISOString(), items: cache.items.map(({ id, label, state, detail }) => ({ id, label, state, detail })) };
});
