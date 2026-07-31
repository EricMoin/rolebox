import { describe, it, expect } from "bun:test";

describe("plan.md kernel function", () => {
  it("resolves with kernel frontmatter fields", async () => {
    const content = await Bun.file("functions/plan.md").text();
    const { metadata, body } = await import("../src/resolver/frontmatter").then(m =>
      m.parseFrontmatter(content),
    );

    expect((metadata as any).produces).toBe("plan");
    expect((metadata as any).gate).toEqual({
      all: ["artifact_exists(plan)", "user_approval"],
    });
    expect((metadata as any).transitions).toBeDefined();
    expect((metadata as any).transitions[0].activate).toContain("execute");
    expect((metadata as any).transitions[0].deactivate).toContain("plan");
    expect((metadata as any).body).toBeUndefined(); // body is separate

    // Check that the body still contains original content (via the parser's
    // body field, not a hand-rolled split — reusing the production parser
    // keeps the test in sync with runtime frontmatter/body separation).
    expect(body).toContain("Investigate");
    expect(body).toContain("Output Format");
    expect(body).toContain("```plan");
  });

  it("extracts body from CRLF content (Windows autocrlf tolerance)", async () => {
    const { parseFrontmatter } = await import("../src/resolver/frontmatter");
    // Fixture whose newlines are CRLF, as git `core.autocrlf` would check out
    // on Windows. The parser must normalize CRLF to LF and still extract the
    // body (and metadata) correctly.
    const crlf = [
      "---",
      "name: crlf-plan",
      "phase: 0",
      "produces: plan",
      "gate: { all: [artifact_exists(plan), user_approval] }",
      "transitions:",
      "  - activate: [execute]",
      "    deactivate: [plan]",
      "---",
      "# Body",
      "Investigate",
      "Output Format",
      "```plan",
    ].join("\r\n");

    const { metadata, body } = parseFrontmatter(crlf);

    expect((metadata as any).produces).toBe("plan");
    expect((metadata as any).transitions).toBeDefined();
    expect(body).toContain("# Body");
    expect(body).toContain("Investigate");
    expect(body).toContain("Output Format");
    expect(body).toContain("```plan");
    // CRLF newlines must be normalized to LF — no stray carriage returns.
    expect(body).not.toContain("\r");
  });
});
