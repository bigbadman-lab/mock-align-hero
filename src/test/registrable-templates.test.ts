import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { TEMPLATES } from "@/lib/templates";

// Every launchable template must be registrable by the database, or its tokens launch but never become products.
describe("registrable templates", () => {
  it("latest register_launch list equals the launchable templates", () => {
    const dir = "docs/pending-migrations";
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const sql = files.map((f) => readFileSync(`${dir}/${f}`, "utf8")).filter((s) => /mcpx_cf_register_launch\s*\(/.test(s) && /NOT IN \(/.test(s)).pop()!;
    const list = [...sql.match(/template_id NOT IN \(([^)]*)\)/)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(list).toEqual(TEMPLATES.map((t) => t.id).sort());
  });
  it("latest mcp_creations template CHECK equals the launchable templates", () => {
    const dir = "docs/pending-migrations";
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const sql = files.map((f) => readFileSync(`${dir}/${f}`, "utf8")).filter((s) => /ADD CONSTRAINT mcp_creations_template_id_check/.test(s)).pop()!;
    const list = [...sql.match(/template_id = ANY \(ARRAY\[([^\]]*)\]/)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(list).toEqual(TEMPLATES.map((t) => t.id).sort());
  });
});
