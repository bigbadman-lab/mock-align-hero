// Clock alignment for the rewards pass loop (GO-LIVE-02). The site's rewards countdown and the Treasury
// windows tick on wall-clock 5-minute boundaries (:00, :05, …). A plain fixed sleep after each pass drifts
// with pass duration, so payouts landed at arbitrary offsets from the countdown. Instead, after a
// successful pass the worker sleeps until `offsetMs` after the next window boundary, so each pass starts
// just after a boundary and payouts land a minute or two after the countdown hits zero, every time.
// Timing only: a mistimed tick runs the same checks slightly early or late; nothing else changes.
export function nextBoundaryDelayMs(nowMs: number, windowMs = 300_000, offsetMs = 30_000): number {
  const elapsed = nowMs % windowMs;
  const target = offsetMs;
  // If we are already past the offset inside this window, wait for the next one.
  const delay = elapsed < target ? target - elapsed : windowMs - elapsed + target;
  // Never hot-loop: floor at 60 s; never exceed one window plus the offset.
  return Math.min(Math.max(delay, 60_000), windowMs + offsetMs);
}
