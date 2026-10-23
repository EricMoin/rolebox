import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setLoggerForTest, applyInheritance, discoverRoles } from "../src/loader/role-loader.ts";
import type { MemoryConfig, RoleConfig, SubAgentConfig } from "../src/types.ts";

let root: string;
const logs: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rolebox-memory-config-"));
  logs.length = 0;
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  __setLoggerForTest({ warn: capture, error: capture, info: capture, debug: () => {} } as any);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRole(path: string, fields: Record<string, unknown>): void {
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "role.yaml"), JSON.stringify({ name: "Example", prompt: "Complete the task.", ...fields }));
}

function child(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, prompt: "Complete the assigned task.", ...extra };
}

describe("role memory configuration", () => {
  it("retains disabled injection, zero limits, and every supported filter", async () => {
    const configs: MemoryConfig[] = [
      { inject: false, max_inject: 0, min_relevance: "high", scope: "role" },
      { inject: true, max_inject: 100, min_relevance: "medium", scope: "workspace" },
      { max_inject: 10, min_relevance: "low", scope: "both" },
      {},
    ];
    configs.forEach((memory, index) => writeRole(`role-${index}`, { memory }));
    writeRole("default", {});
    const roles = await discoverRoles(root);
    configs.forEach((memory, index) => expect(roles.get(`role-${index}`)?.memory).toEqual(memory));
    expect(roles.get("default")).not.toHaveProperty("memory");
    expect(logs).toEqual([]);
  });

  const invalid: Array<[string, unknown, string]> = [
    ["boolean block", false, "memory must be an object"],
    ["null block", null, "memory must be an object"],
    ["array block", [], "memory must be an object"],
    ["string inject", { inject: "false" }, "memory.inject"],
    ["null inject", { inject: null }, "memory.inject"],
    ["negative limit", { max_inject: -1 }, "memory.max_inject"],
    ["fractional limit", { max_inject: 1.5 }, "memory.max_inject"],
    ["oversized limit", { max_inject: 101 }, "memory.max_inject"],
    ["string limit", { max_inject: "10" }, "memory.max_inject"],
    ["null limit", { max_inject: null }, "memory.max_inject"],
    ["invalid relevance", { min_relevance: "urgent" }, "memory.min_relevance"],
    ["invalid scope", { scope: "all" }, "memory.scope"],
    ["unknown field", { injection: false }, "memory.injection"],
  ];

  it.each(invalid)("rejects %s with a diagnostic instead of restoring defaults", async (_name, memory, field) => {
    writeRole("invalid", { memory });
    writeRole("valid", { memory: { inject: false } });
    const roles = await discoverRoles(root);
    expect(roles.has("invalid")).toBe(false);
    expect(roles.get("valid")?.memory).toEqual({ inject: false });
    expect(logs.some((line) => line.includes('"invalid"') && line.includes(field))).toBe(true);
  });

  it("inherits omitted blocks and honors explicit blocks across inline, nested, and file-based children", async () => {
    const memory: MemoryConfig = { inject: false, max_inject: 3, scope: "role" };
    writeRole("parent", {
      memory,
      subagents: [
        child("Inherited", { subagents: [child("Nested")] }),
        child("Override", { memory: { inject: true }, subagents: [child("OverrideNested")] }),
        child("Defaults", { memory: {}, subagents: [child("DefaultNested")] }),
      ],
    });
    writeRole("parent/subagents/file", { name: "File", subagents: [child("FileNested")] });
    writeRole("parent/subagents/file/subagents/deep", { name: "Deep", memory: { max_inject: 0 } });
    writeRole("parent/subagents/override", { name: "FileOverride", memory: { scope: "workspace" } });
    const role = (await discoverRoles(root)).get("parent")!;
    expect(role.memory).toEqual(memory);
    const byName = new Map(role.subagents!.map((agent) => [agent.name, agent]));
    expect(byName.get("Inherited")?.memory).toEqual(memory);
    expect(byName.get("Inherited")?.subagents?.[0].memory).toEqual(memory);
    expect(byName.get("Override")?.memory).toEqual({ inject: true });
    expect(byName.get("Override")?.subagents?.[0].memory).toEqual({ inject: true });
    expect(byName.get("Defaults")?.memory).toEqual({});
    expect(byName.get("Defaults")?.subagents?.[0].memory).toEqual({});
    expect(byName.get("File")?.memory).toEqual(memory);
    const fileChildren = new Map(byName.get("File")!.subagents!.map((agent) => [agent.name, agent]));
    expect(fileChildren.get("FileNested")?.memory).toEqual(memory);
    expect(fileChildren.get("Deep")?.memory).toEqual({ max_inject: 0 });
    expect(byName.get("FileOverride")?.memory).toEqual({ scope: "workspace" });
  });

  it("rejects malformed child blocks without dropping their parent or valid siblings", async () => {
    writeRole("parent", {
      memory: { inject: false },
      subagents: [
        child("BadInline", { memory: { inject: "false" } }),
        child("Good", { subagents: [child("BadNested", { memory: { scope: "invalid" } })] }),
      ],
    });
    writeRole("parent/subagents/bad", { name: "BadFile", memory: { max_inject: -1 } });
    const role = (await discoverRoles(root)).get("parent")!;
    expect(role.subagents?.map((agent) => agent.name)).toEqual(["Good"]);
    expect(role.subagents?.[0].memory).toEqual({ inject: false });
    expect(role.subagents?.[0].subagents).toEqual([]);
    for (const [name, field] of [["BadInline", "inject"], ["BadNested", "scope"], ["BadFile", "max_inject"]]) {
      expect(logs.some((line) => line.includes(name) && line.includes(`memory.${field}`))).toBe(true);
    }
  });

  it("reports inherited memory and leaves the original child unchanged", () => {
    const parent: RoleConfig = { name: "Parent", description: "", prompt: "Task", memory: { inject: false } };
    const nested: SubAgentConfig = { name: "Nested", description: "", prompt: "Task" };
    const original: SubAgentConfig = { name: "Child", description: "", prompt: "Task", subagents: [nested] };
    const result = applyInheritance(parent, original, true);
    expect(result.inheritedFields).toContain("memory");
    expect(result.config.subagents?.[0].memory).toEqual(parent.memory);
    expect(original).not.toHaveProperty("memory");
    expect(nested).not.toHaveProperty("memory");
  });
});
