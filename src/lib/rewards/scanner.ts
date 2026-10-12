// Bounded, resumable read-only scan of finalized signatures for one fee recipient. Injectable RPC; no writes to chain.
// Limits: page ≤ 100, ≤ 5 pages per run, sequential (concurrency 1), per-call timeout. Any RPC failure → UNKNOWN,
// cursor not advanced. Cursor = newest fully processed signature; replays are harmless because ingest is keyed.
import { decodeFeeEvents, type FeeEvidence } from "./pump-events";

export type Rpc = {
  signatures(address: string, opts: { until?: string | undefined; before?: string | undefined; limit: number }): Promise<{ signature: string; slot: number; err: unknown; confirmationStatus?: string }[]>;
  transaction(signature: string): Promise<unknown | null>;
};

export const SCAN_LIMITS = { pageSize: 100, maxPages: 5, timeoutMs: 8_000 } as const;

const timed = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("rpc_timeout")), ms))]);

export type ScanOutcome =
  | { kind: "OK"; events: FeeEvidence[]; newCursor: string | null; scanned: number; complete: boolean }
  | { kind: "UNKNOWN"; reason: string; scanned: number };

export async function scanRecipient(rpc: Rpc, recipient: string, cursor: string | null): Promise<ScanOutcome> {
  const sigs: { signature: string; slot: number; err: unknown; confirmationStatus?: string }[] = [];
  let before: string | undefined;
  let complete = false;
  try {
    for (let p = 0; p < SCAN_LIMITS.maxPages; p++) {
      const page = await timed(rpc.signatures(recipient, { until: cursor ?? undefined, before, limit: SCAN_LIMITS.pageSize }), SCAN_LIMITS.timeoutMs);
      if (!Array.isArray(page)) return { kind: "UNKNOWN", reason: "malformed_page", scanned: sigs.length };
      sigs.push(...page);
      if (page.length < SCAN_LIMITS.pageSize) { complete = true; break; }
      before = page[page.length - 1]!.signature;
    }
  } catch (e) { return { kind: "UNKNOWN", reason: (e as Error).message || "rpc_error", scanned: sigs.length }; }
  if (sigs.some((s) => s.confirmationStatus && s.confirmationStatus !== "finalized")) return { kind: "UNKNOWN", reason: "unfinalized_signature_in_range", scanned: sigs.length };
  const events: FeeEvidence[] = [];
  // Oldest first so the cursor only advances over fully processed history.
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    let tx: unknown;
    try { tx = await timed(rpc.transaction(s.signature), SCAN_LIMITS.timeoutMs); } catch (e) { return { kind: "UNKNOWN", reason: (e as Error).message, scanned: sigs.length }; }
    const d = decodeFeeEvents(tx as never);
    if (d.kind === "UNKNOWN") return { kind: "UNKNOWN", reason: d.reason, scanned: sigs.length };
    if (d.kind === "OK") events.push(...d.events.filter((e) => e.recipient === recipient));
  }
  // Incomplete history (page cap hit) must not move the cursor past unseen gaps.
  return { kind: "OK", events, newCursor: complete ? (sigs[0]?.signature ?? cursor) : cursor, scanned: sigs.length, complete };
}
