import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Read the raw loop function markdown and split YAML frontmatter from body.
 */
function readLoopPrompt(): {
  frontmatter: string;
  body: string;
} {
  const filePath = join(import.meta.dir, "../../functions/loop.md");
  const content = readFileSync(filePath, "utf-8");

  // Normalize Windows CRLF line endings to LF. git's `core.autocrlf` on
  // Windows (default true, and this repo has no .gitattributes to override it)
  // checks out .md files with CRLF, which would otherwise break the literal
  // `\n---` frontmatter-delimiter match below. Mirrors the CRLF normalization
  // in src/resolver/frontmatter.ts.
  const normalizedContent = content.replace(/\r\n/g, "\n");

  // Split on first --- delimiter
  const match = normalizedContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("loop.md does not have valid YAML frontmatter");
  }
  return { frontmatter: match[1], body: match[2] };
}

/**
 * Simulate template substitution like the function engine does.
 */
function renderBody(body: string, iterations: string, mode: string): string {
  return body.replace(/\{iterations\}/g, iterations).replace(/\{mode\}/g, mode);
}

describe("loop.md orchestrator prompt", () => {
  const { frontmatter, body } = readLoopPrompt();
  const defaultRendered = renderBody(body, "5", "inherit");
  const customRendered = renderBody(body, "3", "fresh");

  // ── YAML frontmatter ──

  it("preserves name: loop in frontmatter", () => {
    expect(frontmatter).toMatch(/^name:\s*loop\b/m);
  });

  it("preserves params in frontmatter", () => {
    expect(frontmatter).toMatch(/params:/);
    expect(frontmatter).toMatch(/iterations:\s*5/);
    expect(frontmatter).toMatch(/mode:\s*inherit/);
  });

  // ── Template variables ──

  it("body contains {iterations} template variable", () => {
    expect(body).toContain("{iterations}");
  });

  it("body contains {mode} template variable", () => {
    expect(body).toContain("{mode}");
  });

  it("renders {iterations} correctly when substituted", () => {
    expect(defaultRendered).toContain("for 5 loop rounds");
    expect(customRendered).toContain("for 3 loop rounds");
  });

  it("renders {mode} correctly when substituted", () => {
    expect(defaultRendered).toContain("`inherit` mode");
    expect(customRendered).toContain("`fresh` mode");
  });

  // ── Forbidden content ──

  it("does NOT contain 'first iteration'", () => {
    expect(defaultRendered).not.toMatch(/first\s+iteration/i);
    expect(body).not.toMatch(/first\s+iteration/i);
  });

  it("does NOT contain 'You are the first iteration'", () => {
    expect(defaultRendered).not.toMatch(/you are the first/i);
  });

  // ── Required directives ──

  it("contains no-execute directive (orchestrator does not perform task)", () => {
    expect(defaultRendered).toMatch(/(?:do\s+\*\*)?not\*\*\s+(perform|execute|attempt)/i);
  });

  it("contains summarize directive for round results", () => {
    expect(defaultRendered).toMatch(/summary/i);
    expect(defaultRendered).toMatch(/round's\s+(outcome|work|output)/i);
  });

  it("contains explicit end-your-response directive", () => {
    expect(defaultRendered).toMatch(/end\s+(each\s+)?response/i);
    expect(defaultRendered).toMatch(/stop/i);
  });

  it("contains directive against trailing questions / continuation bait", () => {
    expect(defaultRendered).toMatch(/(?:do\s+\*\*)?not\*\*\s+(?:add|include|ask).*?question/i);
    expect(defaultRendered).toMatch(/continuation\s+bait/i);
  });

  it("contains directive against calling dispatch by orchestrator", () => {
    expect(defaultRendered).toMatch(/never\s+call.*dispatch/i);
  });
});
