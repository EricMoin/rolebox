/// <reference types="bun-types" />

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { createMockClient } from "../dispatch/helpers.ts";
import { __resetForTest } from "../../src/logger.ts";

const DISPATCH_KEYS = [
  "dispatch",
  "dispatch_output",
  "dispatch_status",
  "dispatch_cancel",
  "dispatch_metrics",
];

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  const suffix = Math.random().toString(36).slice(2);
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp/dts-test-" + suffix,
    directory: "/tmp/dts-test-" + suffix,
    core: undefined as any,
    bus: undefined as any,
    capabilities: undefined,
    ...overrides,
  };
}

/**
 * Verifies the restored dispatch_* compatibility shim surface end-to-end on the
 * opencode path: a healthy DispatchService contributes the five real tools, and
 * buildCanonicalTools merges them via `dispatchToolsOverride` exactly as
 * ToolService.init() does (see src/core/services/tool-service.ts). This mirrors
 * what appears in ToolService.getTools() output.
 */
describe("dispatch tool surface (opencode path)", () => {
  beforeEach(() => __resetForTest());
  afterEach(() => {
    mock.restore();
    __resetForTest();
  });

  it("ToolService.getTools() contains the five dispatch_* tools when healthy", async () => {
    const mockClient = createMockClient();
    const svc = new DispatchService({ sessionClient: mockClient });
    const ctx = makeContext();
    await svc.init(ctx);

    // Exact ToolService.init() assembly: dispatchManager, subagent maps, and
    // dispatchToolsOverride from DispatchService.getTools().
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
    });

    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeDefined();
    }

    // dispatch_metrics exec returns a metrics summary (no task needed).
    const metricsResult = await (tools.dispatch_metrics as any).execute(
      { format: "summary", export_path: undefined },
      toolContext(ctx),
    );
    expect(metricsResult).toContain("Dispatch Metrics");

    // dispatch_status exec returns the no-tasks summary (never throws).
    const statusResult = await (tools.dispatch_status as any).execute(
      { task_id: undefined },
      toolContext(ctx),
    );
    expect(statusResult).toContain("Task Status");
  });

  it("dispatch tool definitions are CanonicalToolDefs with execute handlers", async () => {
    const mockClient = createMockClient();
    const svc = new DispatchService({ sessionClient: mockClient });
    await svc.init(makeContext());

    const contributed = svc.getTools() as Record<string, any>;
    for (const key of DISPATCH_KEYS) {
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
    sessionID: "sess-surface-test",
    messageID: "",
    agent: "",
    directory: ctx.directory,
    worktree: "",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}
