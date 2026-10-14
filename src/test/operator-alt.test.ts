import { describe, expect, it } from "vitest";
import { STATIC_ALT_ENTRIES, nextAltStep } from "@/lib/operator/alt-manifest";

const t = (o: Partial<{ address: string; active: boolean; frozen: boolean; hasAllStatic: boolean }>) => ({ address: "T1", entries: 0, active: true, frozen: false, lastExtendedSlot: 1, hasAllStatic: false, ...o });

describe("static lookup table", () => {
  it("has exactly the 13 verified addresses", () => {
    expect(STATIC_ALT_ENTRIES).toHaveLength(13);
    expect(new Set(STATIC_ALT_ENTRIES.map((e) => e.address)).size).toBe(13);
  });
  it("creates only when the deployer owns no table", () => expect(nextAltStep([]).step).toBe("create"));
  it("resumes the existing table instead of creating another", () => expect(nextAltStep([t({})])).toEqual({ step: "extend", table: "T1" }));
  it("blocks when the existing-table check fails", () => expect(nextAltStep(null).step).toBe("check_failed"));
  it("blocks on more than one live table", () => expect(nextAltStep([t({}), t({ address: "T2" })]).step).toBe("conflict"));
});
