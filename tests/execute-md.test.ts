import { describe, it, expect } from "bun:test";

describe("execute.md kernel function", () => {
  it("resolves with kernel frontmatter fields", async () => {
    const content = await Bun.file("functions/execute.md").text();
    const { parseFrontmatter } = await import("../src/skill-resolver");
    const { metadata } = parseFrontmatter(content);

    expect((metadata as any).consumes).toBe("plan");
    expect((metadata as any).requires_evidence).toEqual(["lsp_diagnostics", "test"]);
    expect((metadata as any).continue_until).toEqual({ all: ["plan_todos_complete", "evidence_met"] });
    // The `requires` field must NOT be present
    expect((metadata as any).requires).toBeUndefined();
    // Body still contains original content
    const body = content.split("---\n").slice(2).join("---\n");
    expect(body).toContain("EXECUTION mode");
    expect(body).toContain("todowrite");
    expect(body).toContain("lsp_diagnostics");
  });
});
