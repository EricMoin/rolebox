import { describe, it, expect } from "bun:test";
import type { ResolvedFunction } from "../src/types";

function makeFn(overrides: Partial<ResolvedFunction> & { name: string }): ResolvedFunction {
  return {
    name: overrides.name,
    description: overrides.description ?? `${overrides.name} function`,
    content: overrides.content ?? `Content for ${overrides.name}`,
    filePath: `/tmp/fake/${overrides.name}.md`,
    source: "built-in",
    ...(overrides.priority !== undefined && { priority: overrides.priority }),
    ...(overrides.requires !== undefined && { requires: overrides.requires }),
  };
}

function sortByPriority(fns: ResolvedFunction[]): ResolvedFunction[] {
  return [...fns].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
}

function filterByRequires(
  fns: ResolvedFunction[],
  activeSet: Set<string>,
): { guarded: ResolvedFunction[]; blocked: ResolvedFunction[] } {
  const guarded: ResolvedFunction[] = [];
  const blocked: ResolvedFunction[] = [];
  for (const fn of fns) {
    const missing = (fn.requires ?? []).filter((d) => !activeSet.has(d));
    if (missing.length > 0) {
      blocked.push(fn);
    } else {
      guarded.push(fn);
    }
  }
  return { guarded, blocked };
}

describe("Inject Order — priority sorting", () => {
  it("sorts by priority ascending (10 before 90)", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "late", priority: 90 }),
      makeFn({ name: "early", priority: 10 }),
      makeFn({ name: "mid", priority: 50 }),
    ];

    const sorted = sortByPriority(fns);
    expect(sorted.map((f) => f.name)).toEqual(["early", "mid", "late"]);
  });

  it("defaults priority to 50 when not specified", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "explicitEarly", priority: 10 }),
      makeFn({ name: "defaultMid" }),
      makeFn({ name: "explicitLate", priority: 90 }),
    ];

    const sorted = sortByPriority(fns);
    expect(sorted.map((f) => f.name)).toEqual(["explicitEarly", "defaultMid", "explicitLate"]);
  });

  it("stable order for equal priorities", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "a", priority: 50 }),
      makeFn({ name: "b", priority: 50 }),
      makeFn({ name: "c", priority: 50 }),
    ];

    const sorted = sortByPriority(fns);
    // Sort is stable in V8/bun, so input order preserved for ties
    expect(sorted.map((f) => f.name)).toEqual(["a", "b", "c"]);
  });
});

describe("Inject Order — requires dependency guard", () => {
  it("blocks a function when its required dependency is not active", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "execute", requires: ["plan"] }),
    ];
    const activeSet = new Set<string>(["execute"]);

    const { guarded, blocked } = filterByRequires(fns, activeSet);
    expect(guarded).toHaveLength(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].name).toBe("execute");
  });

  it("allows a function when all its required dependencies are active", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "execute", requires: ["plan"] }),
    ];
    const activeSet = new Set<string>(["plan", "execute"]);

    const { guarded, blocked } = filterByRequires(fns, activeSet);
    expect(guarded).toHaveLength(1);
    expect(blocked).toHaveLength(0);
    expect(guarded[0].name).toBe("execute");
  });

  it("allows functions with no requires field (tier-0)", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "plan" }),
      makeFn({ name: "review" }),
    ];
    const activeSet = new Set<string>(["plan", "review"]);

    const { guarded, blocked } = filterByRequires(fns, activeSet);
    expect(guarded).toHaveLength(2);
    expect(blocked).toHaveLength(0);
    expect(guarded.map((f) => f.name)).toEqual(["plan", "review"]);
  });

  it("blocks only the function with unmet dependencies, not others", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "execute", requires: ["plan"] }),
      makeFn({ name: "review" }),
    ];
    const activeSet = new Set<string>(["execute", "review"]);

    const { guarded, blocked } = filterByRequires(fns, activeSet);
    expect(guarded.map((f) => f.name)).toEqual(["review"]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].name).toBe("execute");
  });

  it("blocks when only some requires are active", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "compile", requires: ["plan", "review"] }),
    ];
    const activeSet = new Set<string>(["plan", "compile"]);

    const { guarded, blocked } = filterByRequires(fns, activeSet);
    expect(guarded).toHaveLength(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].name).toBe("compile");
  });
});

describe("Inject Order — combined priority + requires", () => {
  it("guards first, then sorts the surviving functions by priority", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "plan" }),
      makeFn({ name: "deploy", priority: 90, requires: ["build"] }),
      makeFn({ name: "review", priority: 20 }),
      makeFn({ name: "build", priority: 30, requires: ["plan"] }),
    ];
    const activeSet = new Set<string>(["plan", "review", "build", "deploy"]);

    const { guarded } = filterByRequires(fns, activeSet);
    const sorted = sortByPriority(guarded);

    expect(sorted.map((f) => f.name)).toEqual(["review", "build", "plan", "deploy"]);
  });

  it("blocks deploy when build is not active, sorts remaining", () => {
    const fns: ResolvedFunction[] = [
      makeFn({ name: "plan" }),
      makeFn({ name: "deploy", priority: 90, requires: ["build"] }),
      makeFn({ name: "review", priority: 20 }),
    ];
    const activeSet = new Set<string>(["plan", "review", "deploy"]);

    const { guarded, blocked } = filterByRequires(fns, activeSet);
    const sorted = sortByPriority(guarded);

    expect(blocked.map((f) => f.name)).toEqual(["deploy"]);
    expect(sorted.map((f) => f.name)).toEqual(["review", "plan"]);
  });
});
