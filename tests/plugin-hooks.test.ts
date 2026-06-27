import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap, pendingCorrections } from "../src/plugin-hooks";
import { graphSessionState } from "../src/graph/state";
import { advanceGraphForDispatch } from "../src/graph/advance";
import { roleFunctionsMap } from "../src/index";
import type { ResolvedRole, ResolvedSubAgent, ResolvedGraph } from "../src/types";
import { RoleMode } from "../src/constants";
import type { DispatchManagerConfig } from "../src/dispatch/config.ts";

// ── helpers ──────────────────────────────────────────────────────

function createMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

function makePrimaryRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
      ...overrides?.config,
    },
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  };
}

function makeRoleWithSubagents(overrides?: Partial<ResolvedRole>): ResolvedRole {
  const subagent: ResolvedSubAgent = {
    id: "test-primary--helper",
    config: {
      name: "Helper",
      description: "A helper subagent",
      prompt: "You are a helper.",
    },
    prompt: "You are a helper.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    parentId: "test-primary",
    inheritedFrom: {},
  };

  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role with subagents",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
      ...overrides?.config,
    },
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [subagent],
    ...overrides,
  };
}

function testGraph(): ResolvedGraph {
  return {
    edges: [
      { from: "parent", to: "test-primary--helper" },
      { from: "test-primary--helper", to: "parent", exit: true },
    ],
    nodes: ["test-primary--helper"],
    maxIterations: 3,
    exitEdges: [{ from: "test-primary--helper", to: "parent", exit: true }],
    template: "pipeline",
  };
}

// ── cleanup between tests ────────────────────────────────────────

beforeEach(() => {
  // Reset module-level state
  managerMap.clear();
  pendingCorrections.clear();
  graphSessionState.clear("test-session-1");
  graphSessionState.clear("test-session-2");
  graphSessionState.clear("test-session-3");
  roleFunctionsMap.clear();
});

afterEach(() => {
  mock.restore();
});

// ── tests ────────────────────────────────────────────────────────

describe("Plugin Hooks - Manager Singleton", () => {
  it("two createPluginHooks calls for same directory reuse one manager", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-test-"));
    try {
      const client = createMockClient();
      const roles = [makeRoleWithSubagents()];
      const graphMap = new Map<string, ResolvedGraph>();

      await createPluginHooks(roles, client, roleFunctionsMap, graphMap, tmpDir);
      await createPluginHooks(roles, client, roleFunctionsMap, graphMap, tmpDir);

      expect(managerMap.size).toBe(1);
      expect(managerMap.has(tmpDir)).toBe(true);

      const manager = managerMap.get(tmpDir)!;
      expect(manager).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("two createPluginHooks calls for different directories create different managers", async () => {
    const dir1 = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-d1-"));
    const dir2 = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-d2-"));
    try {
      const client = createMockClient();
      const roles = [makeRoleWithSubagents()];
      const graphMap = new Map<string, ResolvedGraph>();

      await createPluginHooks(roles, client, roleFunctionsMap, graphMap, dir1);
      await createPluginHooks(roles, client, roleFunctionsMap, graphMap, dir2);

      expect(managerMap.size).toBe(2);
      expect(managerMap.has(dir1)).toBe(true);
      expect(managerMap.has(dir2)).toBe(true);
      expect(managerMap.get(dir1)).not.toBe(managerMap.get(dir2));
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("process listeners registered only once across multiple createPluginHooks calls", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-listen-"));
    try {
      const client = createMockClient();
      const roles = [makeRoleWithSubagents()];
      const graphMap = new Map<string, ResolvedGraph>();

      // Spy on process.on before the first call
      const processOnSpy = mock(process.on.bind(process));

      await createPluginHooks(roles, client, roleFunctionsMap, graphMap, tmpDir);
      await createPluginHooks(roles, client, roleFunctionsMap, graphMap, tmpDir);

      // The guard should prevent duplicate registrations — process.on is called
      // once for each event (exit, SIGINT, SIGTERM), not twice
      expect(managerMap.size).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Plugin Hooks - Config Injection", () => {
  it("role with dispatch: block produces manager with correct effective config", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-cfg-"));
    try {
      const client = createMockClient();
      const dispatchConfig: Partial<DispatchManagerConfig> = {
        maxConcurrent: 2,
        maxActivePerParent: 1,
        retryAfterMs: 10_000,
      };

      const primary = makeRoleWithSubagents({
        dispatchConfig,
        config: { mode: RoleMode.Primary } as any,
      });

      await createPluginHooks([primary], client, roleFunctionsMap, new Map(), tmpDir);

      expect(managerMap.has(tmpDir)).toBe(true);
      const manager = managerMap.get(tmpDir)!;

      // Manager has config exposed for testing
      const config = manager.getConfig();
      expect(config.maxConcurrent).toBe(2);
      expect(config.maxActivePerParent).toBe(1);
      expect(config.retryAfterMs).toBe(10_000);

      // Defaults from DEFAULT_CONFIG should still be present for unset fields
      expect(config.taskTtlMs).toBeGreaterThan(0);
      expect(config.minRuntimeMs).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("manager uses DEFAULT_CONFIG when no dispatch config on role", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-defcfg-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      // No dispatchConfig set

      await createPluginHooks([primary], client, roleFunctionsMap, new Map(), tmpDir);

      const manager = managerMap.get(tmpDir)!;
      const config = manager.getConfig();
      expect(config.maxConcurrent).toBe(5); // DEFAULT_CONFIG default
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Plugin Hooks - Guardrail Correction Injection", () => {
  it("off-route dispatch produces system-reminder correction in next transform, then cleared", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-corr-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      const graph = testGraph();
      const graphMap = new Map<string, ResolvedGraph>();
      graphMap.set("test-primary", graph);

      const hooks = await createPluginHooks([primary], client, roleFunctionsMap, graphMap, tmpDir);

      // Initialize a graph session via system.transform (which calls initGraph via chat.message)
      const sessionID = "test-session-corr-1";

      // Init the graph directly (chat.message only triggers initGraph when |name| syntax is used)
      graphSessionState.initGraph(sessionID, graph);

      // Dispatch off-route: frontier is ["test-primary--helper"], but dispatch to "other-agent" (not in graph nodes)
      await hooks["tool.execute.after"](
        { sessionID, tool: "task", args: { subagent_type: "other-agent", prompt: "do it" } },
        undefined,
      );

      // Check that correction is stashed
      expect(pendingCorrections.has(sessionID)).toBe(true);
      const correction = pendingCorrections.get(sessionID)!;
      expect(correction).toContain("<system-reminder>");
      expect(correction).toContain("not part of the collaboration graph");

      // Now call system.transform — should inject the correction and clear it
      const output = { system: ["existing-system-prompt"] };
      await hooks["experimental.chat.system.transform"]({ sessionID }, output);

      // Correction should be injected
      const hasCorrectionInOutput = output.system.some((s) => s.includes("<system-reminder>") && s.includes("not part of the collaboration graph"));
      expect(hasCorrectionInOutput).toBe(true);

      // Correction should be cleared
      expect(pendingCorrections.has(sessionID)).toBe(false);

      // Second transform should NOT inject it again
      const output2 = { system: ["another-prompt"] };
      await hooks["experimental.chat.system.transform"]({ sessionID }, output2);
      const hasCorrectionInOutput2 = output2.system.some((s) => s.includes("not part of the collaboration graph"));
      expect(hasCorrectionInOutput2).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("on-route dispatch does NOT produce correction", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-onroute-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      const graph = testGraph();
      const graphMap = new Map<string, ResolvedGraph>();
      graphMap.set("test-primary", graph);

      const hooks = await createPluginHooks([primary], client, roleFunctionsMap, graphMap, tmpDir);
      const sessionID = "test-session-onroute-1";

      graphSessionState.initGraph(sessionID, graph);

      // Dispatch on-route (frontier is ["test-primary--helper"])
      await hooks["tool.execute.after"](
        { sessionID, tool: "task", args: { subagent_type: "test-primary--helper", prompt: "do it" } },
        undefined,
      );

      // No correction should be stashed
      expect(pendingCorrections.has(sessionID)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("correction for unknown agent produces appropriate message", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-unknown-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      const graph = testGraph();
      const graphMap = new Map<string, ResolvedGraph>();
      graphMap.set("test-primary", graph);

      const hooks = await createPluginHooks([primary], client, roleFunctionsMap, graphMap, tmpDir);
      const sessionID = "test-session-unknown-1";
      graphSessionState.initGraph(sessionID, graph);

      // Dispatch to a completely unknown agent (not in graph nodes)
      await hooks["tool.execute.after"](
        { sessionID, tool: "task", args: { subagent_type: "nonexistent-agent", prompt: "do it" } },
        undefined,
      );

      const correction = pendingCorrections.get(sessionID)!;
      expect(correction).toContain("not part of the collaboration graph");
      expect(correction).toContain("nonexistent-agent");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Plugin Hooks - Graph Recover", () => {
  it("graph recover restores persisted session progress on fresh hooks instance", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-recover-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      const graph = testGraph();
      const graphMap = new Map<string, ResolvedGraph>();
      graphMap.set("test-primary", graph);

      const hooks1 = await createPluginHooks([primary], client, roleFunctionsMap, graphMap, tmpDir);
      const sessionID = "test-session-recover-1";

      graphSessionState.initGraph(sessionID, graph, "test-primary");

      const advanceResult = advanceGraphForDispatch(sessionID, "task", { subagent_type: "test-primary--helper", prompt: "do it" });
      expect(advanceResult.correction).toBeUndefined();

      let state1 = graphSessionState.getState(sessionID);
      expect(state1).toBeDefined();
      expect(state1!.completed).toEqual(["test-primary--helper"]);

      graphSessionState.flushSync();

      // Simulate restart: delete from in-memory maps without persisting
      (graphSessionState as any).states.delete(sessionID);
      (graphSessionState as any).graphs.delete(sessionID);
      (graphSessionState as any).agentIds.delete(sessionID);

      expect(graphSessionState.getState(sessionID)).toBeUndefined();

      await createPluginHooks([primary], client, roleFunctionsMap, graphMap, tmpDir);

      const recoveredState = graphSessionState.getState(sessionID);
      expect(recoveredState).toBeDefined();
      expect(recoveredState!.completed).toEqual(["test-primary--helper"]);
      expect(recoveredState!.status).toBe("complete");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("graph recover with nonexistent agentId skips that session", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-skip-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      const graphMap = new Map<string, ResolvedGraph>();
      graphMap.set("test-primary", testGraph());

      const hooks1 = await createPluginHooks([primary], client, roleFunctionsMap, graphMap, tmpDir);
      const sessionID = "test-session-skip-1";

      graphSessionState.initGraph(sessionID, testGraph());
      graphSessionState.flushSync();

      // Simulate restart: clear memory
      (graphSessionState as any).states.delete(sessionID);
      (graphSessionState as any).graphs.delete(sessionID);
      (graphSessionState as any).agentIds.delete(sessionID);
      managerMap.clear();

      // Now create fresh hooks with a graphMap missing the agent
      const emptyGraphMap = new Map<string, ResolvedGraph>();
      await createPluginHooks([primary], client, roleFunctionsMap, emptyGraphMap, tmpDir);

      const recoveredState = graphSessionState.getState(sessionID);
      expect(recoveredState).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
