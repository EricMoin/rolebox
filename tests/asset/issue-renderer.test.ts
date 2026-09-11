import { describe, it, expect } from "bun:test";
import { renderIssues } from "../../src/asset/issue-renderer.ts";
import type { ValidationIssue } from "../../src/asset/issue-renderer.ts";

describe("issue-renderer", () => {
  describe("formatting", () => {
    it("renders empty state when no issues", () => {
      const result = renderIssues([], undefined);
      expect(result).toContain("✅ All assets are valid");
      expect(result).toContain("no issues found");
    });

    it("renders empty state with role filter scope", () => {
      const result = renderIssues([], "test-role");
      expect(result).toContain("✅ All assets are valid");
      expect(result).toContain("for role `test-role`");
    });

    it("renders a single error", () => {
      const issues: ValidationIssue[] = [
        { asset: "test-role/my-fn", type: "function", issue: "requires nonexistent function: missing-dep", severity: "error" },
      ];
      const result = renderIssues(issues);
      expect(result).toContain("1 issue(s) found");
      expect(result).toContain("1 error(s), 0 warning(s)");
      expect(result).toContain("error");
      expect(result).toContain("my-fn");
      expect(result).toContain("missing-dep");
    });

    it("renders a single warning", () => {
      const issues: ValidationIssue[] = [
        { asset: "test-role/my-fn", type: "function", issue: "unknown condition: bogus_cond", severity: "warning" },
      ];
      const result = renderIssues(issues);
      expect(result).toContain("1 issue(s) found");
      expect(result).toContain("0 error(s), 1 warning(s)");
      expect(result).toContain("warning");
      expect(result).toContain("bogus_cond");
    });

    it("renders multiple issues with role scope", () => {
      const issues: ValidationIssue[] = [
        { asset: "role-a/fn1", type: "function", issue: "issue one", severity: "error" },
        { asset: "role-a/fn2", type: "function", issue: "issue two", severity: "warning" },
      ];
      const result = renderIssues(issues, "role-a");
      expect(result).toContain("for role `role-a`");
      expect(result).toContain("2 issue(s) found");
      expect(result).toContain("1 error(s), 1 warning(s)");
      expect(result).toContain("fn1");
      expect(result).toContain("fn2");
    });
  });

  describe("severity sorting", () => {
    it("sorts errors before warnings", () => {
      const issues: ValidationIssue[] = [
        { asset: "r/fn-warn", type: "function", issue: "a warning", severity: "warning" },
        { asset: "r/fn-err1", type: "function", issue: "an error 1", severity: "error" },
        { asset: "r/fn-err2", type: "function", issue: "an error 2", severity: "error" },
      ];
      const result = renderIssues(issues);
      const lines = result.split("\n");
      const dataRows = lines.filter((l) => l.startsWith("|"));
      // dataRows[0]=header, dataRows[1]=separator, dataRows[2+]=issue rows
      // Errors should come before warnings
      const errIndex = result.indexOf("an error 1");
      const warnIndex = result.indexOf("a warning");
      expect(errIndex).toBeGreaterThan(-1);
      expect(warnIndex).toBeGreaterThan(-1);
      expect(errIndex).toBeLessThan(warnIndex);
    });

    it("preserves relative order within same severity", () => {
      const issues: ValidationIssue[] = [
        { asset: "r/fn-err1", type: "function", issue: "first error", severity: "error" },
        { asset: "r/fn-err2", type: "function", issue: "second error", severity: "error" },
      ];
      const result = renderIssues(issues);
      // Order within same severity should be preserved (stable sort)
      expect(result.indexOf("first error")).toBeLessThan(result.indexOf("second error"));
    });
  });

  describe("table output format", () => {
    it("produces valid markdown table with header and separator", () => {
      const issues: ValidationIssue[] = [
        { asset: "r/fn", type: "function", issue: "error", severity: "error" },
      ];
      const result = renderIssues(issues);
      expect(result).toContain("| Asset | Type | Severity | Issue |");
      expect(result).toContain("|---|---|---|---|");
    });

    it("does not modify the original array (immutable)", () => {
      const issues: ValidationIssue[] = [
        { asset: "r/warn", type: "function", issue: "w", severity: "warning" },
        { asset: "r/err", type: "function", issue: "e", severity: "error" },
      ];
      const copy = [...issues];
      renderIssues(issues);
      expect(issues).toEqual(copy);
    });
  });
});
