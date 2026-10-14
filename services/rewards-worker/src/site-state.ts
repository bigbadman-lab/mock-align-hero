// STEP 2A: bounded read of the site's launch config. A timeout is an error (caller logs state_failed and does
// nothing this pass) — never an "unset" or empty config.
import type { RemoteConfig } from "../../../src/lib/rewards/remote";

type Post = (c: RemoteConfig, path: string, body: unknown) => Promise<unknown>;

export const SITE_STATE_TIMEOUT_MS = 15_000;

export async function fetchSiteState(bridge: RemoteConfig, post: Post, attempts = 2): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await post({ ...bridge, timeoutMs: SITE_STATE_TIMEOUT_MS }, "/api/public/rewards/state", {}); }
    catch (e) { last = e; if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 2_000)); }
  }
  throw last;
}
