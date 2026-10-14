import { describe, it, expect, vi } from "vitest";
const store = new Map<string, { bytes: Uint8Array; contentType: string; sha256: string }>();
vi.mock("@/lib/launch/drafts.server", () => ({ readArtifact: async (p: string) => store.get(p) ?? null }));
import { checkMetadata } from "@/lib/launch/metadata-check.server";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const B = "https://mcpx.fun/api/public/launch-assets/";
const dr = { id: "d", revision: 1, templateId: "t", name: "Child", symbol: "CHD", uri: B + "metadata/m.json" };
store.set("artwork/a.png", { bytes: new Uint8Array([1]), contentType: "image/png", sha256: "x" });

describe("metadata pre-sign check", () => {
  it("accepts our recorded metadata naming this draft with a recorded image", async () => {
    store.set("metadata/m.json", { bytes: enc({ name: "Child", symbol: "CHD", image: B + "artwork/a.png" }), contentType: "application/json", sha256: "y" });
    expect(await checkMetadata(dr.uri, dr)).toBeNull();
  });
  it("rejects metadata whose name differs from the draft", async () => {
    store.set("metadata/m.json", { bytes: enc({ name: "Other", symbol: "CHD", image: B + "artwork/a.png" }), contentType: "application/json", sha256: "y" });
    expect(await checkMetadata(dr.uri, dr)).toBe("METADATA_DRAFT_MISMATCH");
  });
  it("rejects a URI that isn't one of our recorded artifacts", async () => {
    expect(await checkMetadata("https://evil.example/m.json", dr)).toBe("METADATA_URI_NOT_RECORDED");
  });
  it("rejects an image that isn't a recorded artifact", async () => {
    store.set("metadata/m.json", { bytes: enc({ name: "Child", symbol: "CHD", image: "https://evil.example/x.png" }), contentType: "application/json", sha256: "y" });
    expect(await checkMetadata(dr.uri, dr)).toBe("METADATA_IMAGE_NOT_RECORDED");
  });
});
