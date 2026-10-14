// Fast launch wake-up: between launch passes the worker asks the site (cheap sealed read, every ~5 s) whether a
// launch claim is waiting. A fresh claim (< FRESH_MS old) ends the wait at most every BURST_MS so the new token
// is confirmed seconds after finalization; otherwise the normal launch poll interval applies. Errors never wake.
export type Pending = { pending: number; newestCreatedAt: string | null };
export const CHECK_MS = 5_000, BURST_MS = 15_000, FRESH_MS = 3 * 60_000;

export function shouldWake(p: Pending | null, now: number, lastPassAt: number): boolean {
  if (!p || p.pending <= 0 || !p.newestCreatedAt) return false;
  const t = Date.parse(p.newestCreatedAt);
  if (!Number.isFinite(t) || now - t > FRESH_MS) return false;
  return t > lastPassAt || now - lastPassAt >= BURST_MS;
}

export async function waitForLaunch(o: { maxMs: number; lastPassAt: number; check: () => Promise<Pending | null>; stopping: () => boolean;
  sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<"woken" | "timeout"> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + o.maxMs;
  while (!o.stopping() && now() < end) {
    await sleep(Math.min(CHECK_MS, Math.max(0, end - now())));
    let p: Pending | null = null;
    try { p = await o.check(); } catch { p = null; }
    if (shouldWake(p, now(), o.lastPassAt)) return "woken";
  }
  return "timeout";
}
