import { describe, it, expect } from "vitest";
import { commitPass } from "@/lib/rewards/cutoff-snapshot.pg";
import { initIndex } from "@/lib/rewards/holder-index";

// FIX-HIX-02: a holder-list gap that a later complete pass re-covers must be cleared in the same commit,
// so one slow pass on a busy token never pauses payouts permanently.
function fakeDb() {
  const steps: { sql: string; params: unknown[] }[] = [];
  return { steps, db: { tx: async (s: { sql: string; params?: unknown[] }[]) => { s.forEach((x) => steps.push({ sql: x.sql, params: x.params ?? [] })); return { aborted: null }; }, query: async () => ({ rows: [] }) } };
}
const base = () => ({ state: initIndex("MINT", { slot: 100, verified: true, accounts: [] }), expectedCoveredTo: 100, source: "test", txs: [], touched: new Set<string>(), frozen: [], holds: [] });

describe("holder-list gap self-repair", () => {
  it("marks a re-covered gap repaired and resolves its gap holds", async () => {
    const { db, steps } = fakeDb();
    await commitPass(db as never, { ...base(), repairedGaps: [{ fromSlot: 101, toSlot: 200 }], resolveGapHolds: true });
    const gapFix = steps.find((s) => /update public\.mcpx_rw_hix_gaps set repaired_at/.test(s.sql));
    expect(gapFix?.params.slice(0, 3)).toEqual(["MINT", 101, 200]);
    expect(steps.some((s) => /update public\.mcpx_rw_hix_holds set resolved_at/.test(s.sql) && /HOLDER_HISTORY_GAP/.test(s.sql))).toBe(true);
  });
  it("leaves holds alone when no gap was repaired", async () => {
    const { db, steps } = fakeDb();
    await commitPass(db as never, base());
    expect(steps.some((s) => /set repaired_at|set resolved_at/.test(s.sql))).toBe(false);
  });
});
