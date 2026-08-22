/// <reference types="bun-types" />

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { createTaskTools } from "../../src/dispatch/query/task-tools.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { createMockClient } from "../dispatch/helpers.ts";
import { __resetForTest } from "../../src/logger.ts";

const TASK_KEYS = [
  "task_search",
  "task_budget",
  "task_graph",
  "task_retry",
  "task_chronology",
  "task_export",
];

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  const suffix = Math.random().toString(36).slice(2);
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp/task-surface-test-" + suffix,
    directory: "/tmp/task-surface-test-" + suffix,
    core: undefined as any,
    bus: undefined as any,
    capabilities: undefined,
    ...overrides,
  };
}

/**
 * Verifies the restored legacy task_* compatibility surface end-to-end on the
 * opencode path: a healthy DispatchService contributes thin adapters built by
 * createTaskTools, and buildCanonicalTools merges them via `taskToolsOverride`
 * exactly as ToolService.init() does (see src/core/services/tool-service.ts).
 * This mirrors what appears in ToolService.getTools() output.
 */
describe("task tool surface (opencode path)", () => {
  beforeEach(() => __resetForTest());
  afterEach(() => {
    mock.restore();
    __resetForTest();
  });

  it("ToolService.getTools() contains the seven task_* tools when healthy", async () => {
    const mockClient = createMockClient();
    const svc = new DispatchService({ sessionClient: mockClient });
    const ctx = makeContext();
    await svc.init(ctx);

    // Exact ToolService.init() assembly: dispatchManager + taskToolsOverride
    // built via createTaskTools with the dispatch directory.
    const tools = buildCanonicalTools({
      sessionClient: mockClient,
      dispatchManager: svc.getDispatchManager(),
      resolvedSubagents: svc.getResolvedSubagents(),
      subagentModelKey: svc.getSubagentModelKey(),
      resolvedRoles: ctx.resolvedRoles,
      directory: ctx.directory,
      capabilities: { platformId: "opencode", hasSessionCreate: true } as any,
      dispatchToolsOverride: svc.getTools() as Record<string, any>,
      extraTools: {},
      taskToolsOverride: createTaskTools(
        svc.getDispatchManager(),
        ctx.directory,
      ) as Record<string, any>,
    });

    for (const key of TASK_KEYS) {
      expect(tools[key]).toBeDefined();
    }

    // task_search on an empty task set returns the no-tasks notice (never throws).
    const searchResult = await (tools.task_search as any).execute(
      { query: "anything" },
      toolContext(ctx),
    );
    expect(searchResult).toContain("No dispatch tasks found.");
  });

  it("task tool definitions are CanonicalToolDefs with execute handlers", async () => {
    const mockClient = createMockClient();
    const svc = new DispatchService({ sessionClient: mockClient });
    const ctx = makeContext();
    await svc.init(ctx);

    const contributed = createTaskTools(svc.getDispatchManager(), ctx.directory) as Record<string, any>;
    for (const key of TASK_KEYS) {
      expect(contributed[key]).toBeDefined();
      // CanonicalToolDef contract: zod args + async execute.
      expect(typeof (contributed[key] as any).execute).toBe("function");
      expect((contributed[key] as any).args).toBeDefined();
      expect((contributed[key] as any).description).toBeTruthy();
    }
  });
});

function toolContext(ctx: PluginContext) {
  return {
    sessionID: "sess-task-surface-test",
    messageID: "",
    agent: "",
    directory: ctx.directory,
    worktree: "",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}
