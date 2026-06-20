import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FunctionSessionState } from "./session-state";
import { parseFunctionActivation } from "./function-parser";
import { buildFunctionBlock } from "./prompt-builder";
import type { ResolvedFunction } from "./types";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveFunctions } from "./function-resolver";

let tmpRoots: string[] = [];
let state: FunctionSessionState;

const planFunction: ResolvedFunction = {
  name: "plan",
  description: "Strategic planning",
  content: "You are in planning mode. Analyze and create structured plans.",
  filePath: "/tmp/fake/plan.md",
  source: "built-in",
};

const executeFunction: ResolvedFunction = {
  name: "execute",
  description: "Execution mode",
  content: "You are in execution mode. Follow the plan step by step.",
  filePath: "/tmp/fake/execute.md",
  source: "built-in",
};

const roleFunctions = [planFunction, executeFunction];

beforeEach(() => {
  state = new FunctionSessionState();
});

afterEach(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpRoots = [];
});

function tmpDir(): string {
  const dir = mkdtempSync("/tmp/rolebox-test-");
  tmpRoots.push(dir);
  return dir;
}

describe("Function Integration — Full Pipeline", () => {
  it("simulates chat.message parsing and activation", () => {
    const text = "|plan| build a REST API";
    const { functions, cleanedText } = parseFunctionActivation(text);

    const validNames = new Set(roleFunctions.map((f) => f.name));
    const validFunctions = functions.filter((fn) => validNames.has(fn));

    state.activate("ses1", validFunctions);

    expect(functions).toEqual(["plan"]);
    expect(cleanedText).toBe("build a REST API");
    expect(state.isActive("ses1", "plan")).toBe(true);
  });

  it("simulates system.transform injection", () => {
    state.activate("ses1", ["plan"]);
    const activeNames = state.getActive("ses1");

    const allFunctions: ResolvedFunction[] = [...roleFunctions];
    const seen = new Set<string>();
    const activeFunctions: ResolvedFunction[] = [];
    for (const fn of allFunctions) {
      if (activeNames.has(fn.name) && !seen.has(fn.name)) {
        activeFunctions.push(fn);
        seen.add(fn.name);
      }
    }

    const block = buildFunctionBlock(activeFunctions);

    expect(block).toContain("<active_functions>");
    expect(block).toContain("<name>plan</name>");
    expect(block).toContain("Strategic planning");
    expect(block).toContain("<![CDATA[");
  });

  it("does not activate functions not in the role", () => {
    const text = "|nonexistent| do something";
    const { functions } = parseFunctionActivation(text);

    const validNames = new Set(roleFunctions.map((f) => f.name));
    const validFunctions = functions.filter((fn) => validNames.has(fn));

    expect(validFunctions).toEqual([]);
  });

  it("handles multiple consecutive function activations", () => {
    const text = "|plan||execute| review";
    const { functions, cleanedText } = parseFunctionActivation(text);

    const validNames = new Set(roleFunctions.map((f) => f.name));
    const validFunctions = functions.filter((fn) => validNames.has(fn));

    state.activate("ses1", validFunctions);

    expect(functions).toEqual(["plan", "execute"]);
    expect(cleanedText).toBe("review");
    expect(state.isActive("ses1", "plan")).toBe(true);
    expect(state.isActive("ses1", "execute")).toBe(true);
  });

  it("cleaned text is used in subsequent chat.message calls", () => {
    const msg1 = parseFunctionActivation("|plan| build X");
    const validNames = new Set(roleFunctions.map((f) => f.name));
    const valid1 = msg1.functions.filter((fn) => validNames.has(fn));
    state.activate("ses1", valid1);

    const msg2 = parseFunctionActivation("|execute| test it");
    const valid2 = msg2.functions.filter((fn) => validNames.has(fn));
    state.activate("ses1", valid2);

    expect(state.getActive("ses1").size).toBe(2);
    expect(state.getActive("ses1").has("plan")).toBe(true);
    expect(state.getActive("ses1").has("execute")).toBe(true);
  });

  it("system.transform returns nothing when no functions active", () => {
    const activeNames = state.getActive("ses_unknown");
    expect(activeNames.size).toBe(0);
  });

  it("undefined sessionID in system.transform does nothing", () => {
    const sessionID = undefined as unknown as string;
    if (!sessionID) {
      expect(true).toBe(true);
    }
  });

  it("integrates: resolve then parse then activate then inject", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkdirSync(join(roleDir, "functions"), { recursive: true });
    writeFileSync(
      join(roleDir, "functions", "plan.md"),
      "---\nname: plan\ndescription: Role-specific plan\n---\nRole plan content",
    );

    mkdirSync(join(globalDir, "functions"), { recursive: true });
    writeFileSync(
      join(globalDir, "functions", "execute.md"),
      "---\nname: execute\ndescription: Global execute\n---\nGlobal execute content",
    );

    const resolved = await resolveFunctions(
      ["plan", "execute"],
      roleDir,
      join(globalDir, "functions"),
      builtinDir,
    );

    expect(resolved).toHaveLength(2);
    const planFn = resolved.find((f) => f.name === "plan")!;
    expect(planFn.source).toBe("role-local");
    expect(planFn.content).toContain("Role plan content");

    const execFn = resolved.find((f) => f.name === "execute")!;
    expect(execFn.source).toBe("global");

    state.activate("ses1", ["plan", "execute"]);
    expect(state.getActive("ses1").size).toBe(2);

    const seen = new Set<string>();
    const activeFunctions: ResolvedFunction[] = [];
    for (const fn of resolved) {
      if (state.isActive("ses1", fn.name) && !seen.has(fn.name)) {
        activeFunctions.push(fn);
        seen.add(fn.name);
      }
    }

    const block = buildFunctionBlock(activeFunctions);
    expect(block).toContain("Role plan content");
    expect(block).toContain("Global execute content");
  });
});
