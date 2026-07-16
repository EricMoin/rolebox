import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ResolvedRole,
  ResolvedFunction,
  ResolvedReference,
  ResolvedSubAgent,
  Condition,
} from "../../src/types.ts";
import {
  collectAllFunctions,
  checkMissingDependencies,
  checkBrokenReferences,
  checkTransitionConditions,
  renderIssues,
} from "../../src/asset/asset-validators.ts";
import type { ValidationIssue } from "../../src/asset/asset-validators.ts";
import { FunctionSource, ReferenceScope } from "../../src/constants.ts";

// ── Test fixture helpers ─────────────────────────────────────────────────

function makeFn(name: string, overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name,
    description: `Function ${name}`,
    content: `export function ${name}() {}`,
    filePath: `/roles/test/functions/${name}.ts`,
    source: FunctionSource.RoleLocal,
    ...overrides,
  } as unknown as ResolvedFunction;
}

function makeRef(name: string, filePath: string): ResolvedReference {
  return {
    name,
    filePath,
    description: `Reference ${name}`,
    scope: ReferenceScope.Role,
    relativePath: filePath,
  };
}

function makeSubAgent(id: string, overrides: Partial<ResolvedSubAgent> = {}): ResolvedSubAgent {
  return {
    id,
    config: { name: id, description: id, prompt: `You are ${id}` },
    prompt: `You are ${id}`,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    parentId: "root",
    inheritedFrom: {},
    ...overrides,
  } as unknown as ResolvedSubAgent;
}

function makeRole(id: string, overrides: Partial<ResolvedRole> = {}): ResolvedRole {
  return {
    id,
    config: { name: id, description: `Role ${id}`, prompt: `You are ${id}` },
    prompt: `You are ${id}`,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  } as unknown as ResolvedRole;
}

/**
 * A file path that definitely does NOT exist on disk.
 * Used for checkBrokenReferences "missing file" tests.
 */
const MISSING_PATH = "/tmp/rolebox-test-nonexistent-file-xyzzy.test";
/** A file path that definitely DOES exist (the test file's own source). */
const EXISTING_PATH = import.meta.dir
  ? join(import.meta.dir, "..", "..", "src", "asset", "asset-validators.ts")
  : "";

// ── Tests ────────────────────────────────────────────────────────────────

describe("asset-validators", () => {
  // ── collectAllFunctions ───────────────────────────────────────────────

  describe("collectAllFunctions", () => {
    it("collects functions from flat roles", () => {
      const roles: ResolvedRole[] = [
        makeRole("role-a", { functions: [makeFn("fn1"), makeFn("fn2")] }),
        makeRole("role-b", { functions: [makeFn("fn3")] }),
      ];
      const map = collectAllFunctions(roles);
      expect(map.size).toBe(3);
      expect(map.get("fn1")).toHaveLength(1);
      expect(map.get("fn1")![0].ownerId).toBe("role-a");
      expect(map.get("fn2")![0].ownerId).toBe("role-a");
      expect(map.get("fn3")![0].ownerId).toBe("role-b");
    });

    it("collects functions from nested subagents", () => {
      const roles: ResolvedRole[] = [
        makeRole("parent", {
          functions: [makeFn("parentFn")],
          subagents: [
            makeSubAgent("child", {
              functions: [makeFn("childFn")],
              subagents: [
                makeSubAgent("grandchild", {
                  functions: [makeFn("grandFn")],
                }),
              ],
            }),
          ],
        }),
      ];
      const map = collectAllFunctions(roles);
      expect(map.size).toBe(3);
      expect(map.get("parentFn")![0].ownerId).toBe("parent");
      expect(map.get("childFn")![0].ownerId).toBe("parent/child");
      expect(map.get("grandFn")![0].ownerId).toBe("parent/child/grandchild");
    });

    it("deduplicates same-named functions across roles", () => {
      const roles: ResolvedRole[] = [
        makeRole("role-a", { functions: [makeFn("shared")] }),
        makeRole("role-b", { functions: [makeFn("shared")] }),
      ];
      const map = collectAllFunctions(roles);
      expect(map.get("shared")).toHaveLength(2);
      expect(map.get("shared")![0].ownerId).toBe("role-a");
      expect(map.get("shared")![1].ownerId).toBe("role-b");
    });

    it("returns empty map for empty roles array", () => {
      const map = collectAllFunctions([]);
      expect(map.size).toBe(0);
    });
  });

  // ── checkMissingDependencies ──────────────────────────────────────────

  describe("checkMissingDependencies", () => {
    it("reports no issues when all dependencies exist", () => {
      const roles: ResolvedRole[] = [
        makeRole("role-a", {
          functions: [makeFn("fn1", { requires: ["fn2"] }), makeFn("fn2")],
        }),
      ];
      const issues = checkMissingDependencies(roles, new Set(["fn2"]));
      expect(issues).toHaveLength(0);
    });

    it("reports no issues when function has no dependencies", () => {
      const roles: ResolvedRole[] = [
        makeRole("role-a", { functions: [makeFn("fn1")] }),
      ];
      const issues = checkMissingDependencies(roles, new Set());
      expect(issues).toHaveLength(0);
    });

    it("reports missing dependency as error", () => {
      const roles: ResolvedRole[] = [
        makeRole("role-a", {
          functions: [makeFn("fn1", { requires: ["missing-dep"] })],
        }),
      ];
      const issues = checkMissingDependencies(roles, new Set());
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("error");
      expect(issues[0].type).toBe("function");
      expect(issues[0].issue).toContain("missing-dep");
      expect(issues[0].asset).toBe("role-a/fn1");
    });

    it("reports missing dependency in subagent functions", () => {
      const roles: ResolvedRole[] = [
        makeRole("parent", {
          subagents: [
            makeSubAgent("child", {
              functions: [makeFn("subFn", { requires: ["ghost"] })],
            }),
          ],
        }),
      ];
      const issues = checkMissingDependencies(roles, new Set());
      expect(issues).toHaveLength(1);
      expect(issues[0].asset).toBe("parent/child/subFn");
      expect(issues[0].issue).toContain("ghost");
    });

    it("applies roleFilter to include matching subagent children", () => {
      const roles: ResolvedRole[] = [
        makeRole("parent", {
          subagents: [
            makeSubAgent("child-a", {
              functions: [makeFn("subFn", { requires: ["ghost"] })],
            }),
            makeSubAgent("child-b", {
              functions: [makeFn("otherFn", { requires: ["ghost"] })],
            }),
          ],
        }),
      ];
      // Filter by parent/child-a — only that subagent's deps are reported
      const issues = checkMissingDependencies(roles, new Set(), "parent/child-a");
      expect(issues).toHaveLength(1);
      expect(issues[0].asset).toBe("parent/child-a/subFn");
    });
  });

  // ── checkBrokenReferences ─────────────────────────────────────────────

  describe("checkBrokenReferences", () => {
    it("reports no issue for existing file", async () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          references: [makeRef("valid-ref", EXISTING_PATH)],
        }),
      ];
      const issues = await checkBrokenReferences(roles);
      expect(issues).toHaveLength(0);
    });

    it("reports issue for missing file", async () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          references: [makeRef("broken-ref", MISSING_PATH)],
        }),
      ];
      const issues = await checkBrokenReferences(roles);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("error");
      expect(issues[0].type).toBe("reference");
      expect(issues[0].issue).toContain("file not found");
      expect(issues[0].asset).toBe("test-role/broken-ref");
    });

    it("skips references with null/empty filePath", async () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          references: [
            {
              name: "empty-ref",
              filePath: "",
              description: "Empty path ref",
              scope: ReferenceScope.Role,
              relativePath: "",
            },
          ],
        }),
      ];
      const issues = await checkBrokenReferences(roles);
      expect(issues).toHaveLength(0);
    });

    it("checks references in subagents", async () => {
      const roles: ResolvedRole[] = [
        makeRole("parent", {
          subagents: [
            makeSubAgent("child", {
              references: [makeRef("child-ref", MISSING_PATH)],
            }),
          ],
        }),
      ];
      const issues = await checkBrokenReferences(roles);
      expect(issues).toHaveLength(1);
      expect(issues[0].asset).toBe("parent/child/child-ref");
    });
  });

  // ── checkTransitionConditions (exercises extractConditionNames) ───────

  describe("checkTransitionConditions", () => {
    it("reports no issues for valid known (bare string) condition", () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          functions: [
            {
              ...makeFn("myFn"),
              transitions: [{ when: "user_approval" as Condition, activate: ["nextFn"] }],
            },
          ],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set(["user_approval"]));
      expect(issues).toHaveLength(0);
    });

    it("extracts condition name from CALL_RE format (name(args))", () => {
      // extractConditionNames("artifact_exists(plan)") → extracts "artifact_exists"
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          functions: [
            {
              ...makeFn("fnWithCall"),
              transitions: [
                { when: "artifact_exists(plan)" as Condition, activate: ["next"] },
              ],
            },
          ],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set(["user_approval"]));
      expect(issues).toHaveLength(1);
      expect(issues[0].issue).toContain("artifact_exists");
    });

    it("reports warning for unknown bare string condition", () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          functions: [
            {
              ...makeFn("myFn"),
              transitions: [{ when: "bogus_condition" as Condition, activate: ["nextFn"] }],
            },
          ],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set(["user_approval"]));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("warning");
      expect(issues[0].issue).toContain("bogus_condition");
      expect(issues[0].asset).toBe("test-role/myFn");
    });

    it("handles nested compound conditions (all/any/not)", () => {
      // Tests all, any, and not in one nested structure
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          functions: [
            {
              ...makeFn("compoundFn"),
              transitions: [
                {
                  when: {
                    all: [
                      "user_approval",
                      { any: ["unknown_a", "unknown_b"] },
                      { not: "unknown_c" },
                    ],
                  } as Condition,
                  activate: ["nextFn"],
                },
              ],
            },
          ],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set(["user_approval"]));
      expect(issues).toHaveLength(3);
      expect(issues.every((i) => i.severity === "warning")).toBe(true);
      const names = issues.map((i) => i.issue).join(" ");
      expect(names).toContain("unknown_a");
      expect(names).toContain("unknown_b");
      expect(names).toContain("unknown_c");
    });

    it("handles not operator condition", () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          functions: [
            {
              ...makeFn("notFn"),
              transitions: [{ when: { not: "mystery_cond" } as Condition, deactivate: ["otherFn"] }],
            },
          ],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set());
      expect(issues).toHaveLength(1);
      expect(issues[0].issue).toContain("mystery_cond");
    });

    it("reports no issues when function has no transitions", () => {
      const roles: ResolvedRole[] = [
        makeRole("test-role", {
          functions: [makeFn("plainFn")],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set());
      expect(issues).toHaveLength(0);
    });

    it("checks transitions in subagent functions", () => {
      const roles: ResolvedRole[] = [
        makeRole("parent", {
          subagents: [
            makeSubAgent("child", {
              functions: [
                {
                  ...makeFn("subFn"),
                  transitions: [{ when: "ghost_cond" as Condition, activate: ["x"] }],
                },
              ],
            }),
          ],
        }),
      ];
      const issues = checkTransitionConditions(roles, new Set());
      expect(issues).toHaveLength(1);
      expect(issues[0].asset).toBe("parent/child/subFn");
    });
  });

  // ── renderIssues ──────────────────────────────────────────────────────

  describe("renderIssues", () => {
    it("renders empty state when no issues", () => {
      const result = renderIssues([]);
      expect(result).toContain("✅ All assets are valid");
      expect(result).toContain("no issues found");
    });

    it("renders empty state with role filter scope", () => {
      const result = renderIssues([], "test-role");
      expect(result).toContain("for role `test-role`");
    });

    it("renders errors with correct counts and badge", () => {
      const issues: ValidationIssue[] = [
        { asset: "role/fn1", type: "function", issue: "requires nonexistent: x", severity: "error" },
      ];
      const result = renderIssues(issues);
      expect(result).toContain("1 issue(s) found");
      expect(result).toContain("1 error(s), 0 warning(s)");
      expect(result).toContain("🔴 error");
      expect(result).toContain("role/fn1");
    });

    it("renders warnings with correct counts and badge", () => {
      const issues: ValidationIssue[] = [
        { asset: "role/fn1", type: "function", issue: "unknown condition: x", severity: "warning" },
      ];
      const result = renderIssues(issues);
      expect(result).toContain("0 error(s), 1 warning(s)");
      expect(result).toContain("🟡 warning");
    });

    it("sorts errors before warnings in output", () => {
      const issues: ValidationIssue[] = [
        { asset: "role/fnW", type: "function", issue: "warning issue", severity: "warning" },
        { asset: "role/fnE", type: "function", issue: "error issue", severity: "error" },
      ];
      const result = renderIssues(issues);
      const errorIdx = result.indexOf("🔴 error");
      const warningIdx = result.indexOf("🟡 warning");
      expect(errorIdx).toBeLessThan(warningIdx);
    });

    it("includes roleFilter in header when provided with issues", () => {
      const issues: ValidationIssue[] = [
        { asset: "filtered/fn", type: "function", issue: "some issue", severity: "error" },
      ];
      const result = renderIssues(issues, "filter-role");
      expect(result).toContain("for role `filter-role`");
    });

    it("renders multiple issues with mixed severities", () => {
      const issues: ValidationIssue[] = [
        { asset: "role/fn1", type: "function", issue: "error A", severity: "error" },
        { asset: "role/fn2", type: "function", issue: "warning B", severity: "warning" },
        { asset: "role/fn3", type: "reference", issue: "error C", severity: "error" },
      ];
      const result = renderIssues(issues);
      expect(result).toContain("3 issue(s) found");
      expect(result).toContain("2 error(s), 1 warning(s)");
      // Errors appear first (sorted)
      expect(result.indexOf("error A")).toBeLessThan(result.indexOf("warning B"));
    });
  });
});
