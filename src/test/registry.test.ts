import { describe, expect, it } from "vitest";
import { classifyRegistryError, REGISTRY_PAGE_SIZE } from "@/lib/registry";

describe("registry read contract", () => {
  it("caps a page at 25 rows", () => expect(REGISTRY_PAGE_SIZE).toBe(25));
  it("treats a missing table as schema_missing, not empty", () => {
    expect(classifyRegistryError({ code: "42P01" })).toBe("schema_missing");
    expect(classifyRegistryError({ code: "PGRST205" })).toBe("schema_missing");
  });
  it("treats permission denied as access_denied", () => expect(classifyRegistryError({ code: "42501" })).toBe("access_denied"));
  it("treats network failure as unavailable", () => expect(classifyRegistryError({ message: "Failed to fetch" })).toBe("unavailable"));
});
