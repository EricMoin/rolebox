import { describe, it, expect } from "bun:test";

describe("execute.md kernel function", () => {
  it("resolves with kernel frontmatter fields", async () => {
    const content = await Bun.file("functions/execute.md").text();
    const { parseFrontmatter } = await import("../src/resolver/frontmatter");
    const { metadata, body } = parseFrontmatter(content);

    expect((metadata as any).consumes).toBe("plan");
    expect((metadata as any).requires_evidence).toEqual(["lsp_diagnostics", "test"]);
    expect((metadata as any).continue_until).toEqual({ all: ["plan_todos_complete", "evidence_met"] });
    // The `requires` field must NOT be present
    expect((metadata as any).requires).toBeUndefined();
    // Body still contains original content (via the parser's body field, not a
    // hand-rolled split — reusing the production parser keeps the test in sync
    // with how frontmatter/body are actually separated at runtime).
    expect(body).toContain("EXECUTION mode");
    expect(body).toContain("todowrite");
    expect(body).toContain("lsp_diagnostics");
  });

  it("extracts body from CRLF content (Windows autocrlf tolerance)", async () => {
    const { parseFrontmatter } = await import("../src/resolver/frontmatter");
    // Fixture whose newlines are CRLF, as git `core.autocrlf` would check out
    // on Windows. The parser must normalize CRLF to LF and still extract the
    // body (and metadata) correctly.
    const crlf = [
      "---",
      "name: crlf-execute",
      "phase: 0",
      "consumes: plan",
      "requires_evidence: [lsp_diagnostics, test]",
      "continue_until: { all: [plan_todos_complete, evidence_met] }",
      "---",
      "# Body",
      "EXECUTION mode",
      "todowrite",
      "lsp_diagnostics",
    ].join("\r\n");

    const { metadata, body } = parseFrontmatter(crlf);

    expect((metadata as any).consumes).toBe("plan");
    expect(body).toContain("# Body");
    expect(body).toContain("EXECUTION mode");
    expect(body).toContain("todowrite");
    expect(body).toContain("lsp_diagnostics");
    // CRLF newlines must be normalized to LF — no stray carriage returns.
    expect(body).not.toContain("\r");
  });
});
