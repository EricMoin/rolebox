import { describe, it, expect } from "bun:test";

describe("plan.md kernel function", () => {
  it("resolves with kernel frontmatter fields", async () => {
    const content = await Bun.file("functions/plan.md").text();
    const { metadata } = await import("../src/skill-resolver").then(m =>
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

    // Check that the body still contains original content
    const body = content.split("---\n").slice(2).join("---\n");
    expect(body).toContain("Investigate");
    expect(body).toContain("Output Format");
    expect(body).toContain("```plan");
  });
});
