import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSystemTransform } from "../../src/hooks/system-transform.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import type { ResolvedRole } from "../../src/types.ts";

let directory: string;
let role: ResolvedRole;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rolebox-hook-memory-"));
  role = {
    id: "parent", config: { name: "Parent", description: "", prompt: "Parent" },
    prompt: "Parent", skills: [], references: [], functions: [],
    subagents: [{
      id: "parent--child", parentId: "parent", inheritedFrom: {},
      config: { name: "Child", description: "", prompt: "Child" },
      prompt: "Child", skills: [], references: [], functions: [], subagents: [],
    }],
  };
});

afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function transform(agent = "parent--child", worker = false): Promise<string> {
  const deps: HookDeps = {
    session: {} as never, roleFunctionsMap: new Map(), roleMap: new Map([[role.id, role]]),
    dir: directory, dispatchManager: {} as never, loopManager: {} as never,
    customHooks: { runHooks: async () => {} } as never, isGraphWorker: () => worker,
  };
  const output = { system: [] as string[] };
  await handleSystemTransform({ sessionID: "memory-context", agent }, output, new HookState(), deps);
  return output.system.join("\n\n");
}

async function seed(): Promise<void> {
  const store = await MemoryStore.create(directory);
  try {
    for (const [scope, roleId, title] of [
      ["role", "parent--child", "Child decision"],
      ["role", "parent", "Parent private decision"],
      ["role", "unrelated", "Unrelated private decision"],
      ["workspace", "shared", "Workspace decision"],
    ]) {
      store.write({ scope, role_id: roleId, title, content: title, category: "fact", relevance: "high", tags: [], session_id: null, source_sessions: [] });
    }
  } finally {
    store.close();
  }
}

describe("ordinary session memory context", () => {
  it("teaches memory use with an empty store", async () => {
    const prompt = await transform();
    expect(prompt).toContain("## Memory workflow");
    expect(prompt).toContain("memory_recall");
    expect(prompt).toContain("memory_update");
    expect(prompt).not.toContain("## Available memory");
  });

  it("resolves nested roles and shows only their own and workspace summaries", async () => {
    await seed();
    const prompt = await transform();
    expect(prompt).toContain("Child decision");
    expect(prompt).toContain("Workspace decision");
    expect(prompt).not.toContain("Parent private decision");
    expect(prompt).not.toContain("Unrelated private decision");
  });

  it("keeps workflow when a nested role disables automatic summaries", async () => {
    await seed();
    role.subagents[0].config.memory = { inject: false };
    const prompt = await transform();
    expect(prompt).toContain("## Memory workflow");
    expect(prompt).not.toContain("## Available memory");
    expect(prompt).not.toContain("Child decision");
  });

  it("does not advertise blocked tools or reveal summaries to a write-only role", async () => {
    await seed();
    role.subagents[0].config.tools = { "memory_*": false, memory_write: true };
    const prompt = await transform();
    expect(prompt).toContain("memory_write");
    for (const name of ["memory_recall", "memory_read", "memory_list", "memory_update"]) expect(prompt).not.toContain(name);
    expect(prompt).not.toContain("## Available memory");
    role.subagents[0].config.tools = { "memory_*": false };
    expect(await transform()).toBe("");
  });

  it("keeps graph workers and unknown roles outside the ordinary memory path", async () => {
    await seed();
    // The worker hook carries the worker's role, never the ordinary memory
    // path: no workflow hint and no summary from any scope reaches it.
    const worker = await transform("parent--child", true);
    expect(worker).toContain("## Role instructions");
    expect(worker).not.toContain("## Memory workflow");
    expect(worker).not.toContain("Child decision");
    expect(worker).not.toContain("Workspace decision");
    expect(await transform("unknown")).toBe("");
  });
});
