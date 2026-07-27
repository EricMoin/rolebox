/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { buildCanonicalTools } from "../src/platform/tool-assembly.ts";
import type { BuildToolsOptions } from "../src/platform/tool-assembly.ts";
import type { ResolvedRole } from "../src/types.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import { defineTool } from "../src/platform/ports/tool-factory.ts";
import { defaultCapabilities } from "../src/platform/capabilities.ts";
import { z } from "zod";

// ── Test fixtures ──────────────────────────────────────────────────────────

function makeResolvedRole(): ResolvedRole {
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A minimal test role",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  } as ResolvedRole;
}

function makeBaseOpts(): BuildToolsOptions {
  return {
    resolvedRoles: [makeResolvedRole()],
    directory: "/tmp/test",
    capabilities: defaultCapabilities(),
  };
}

function makeDummyTool(name: string) {
  return defineTool({
    description: `Dummy ${name} tool for tests`,
    args: {
      text: z.string().optional(),
    },
    async execute() {
      return `dummy ${name}`;
    },
  });
}

function makeSessionClient(): ISessionClient {
  return {
    list: async () => [],
    get: async () => null,
    messages: async () => [],
    children: async () => [],
    todo: async () => [],
    diff: async () => [],
    fork: async () => null,
    status: async () => null,
    prompt: async () => null,
    promptSync: async () => null,
    create: async () => null,
    abort: async () => false,
  };
}

function makeDispatchManager(): DispatchManager {
  return {
    getTasksByParent: () => [],
    getTask: () => undefined,
    getEventState: () => new Map(),
  } as unknown as DispatchManager;
}

// ── Core key sets ──────────────────────────────────────────────────────────

const CORE_KEYS = [
  "hashline_read",
  "hashline_edit",
  "memory_write",
  "memory_recall",
  "memory_list",
  "web_search",
  "web_read",
  "web_fetch",
  "signal",
  "asset_search",
  "asset_inspect",
  "asset_validate",
  "reference_search",
];

const SESSION_KEYS = [
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "session_diff",
  "session_fork",
];

const DISPATCH_KEYS = [
  "dispatch",
  "dispatch_output",
  "dispatch_cancel",
  "dispatch_metrics",
  "dispatch_status",
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildCanonicalTools", () => {
  it("returns a Record with expected core tool keys when given valid options", () => {
    const tools = buildCanonicalTools(makeBaseOpts());

    for (const key of CORE_KEYS) {
      expect(tools[key]).toBeDefined();
    }
    // No session or dispatch tools yet
    for (const key of SESSION_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("includes session tools when sessionClient is provided", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();

    const tools = buildCanonicalTools(opts);

    for (const key of CORE_KEYS) {
      expect(tools[key]).toBeDefined();
    }
    for (const key of SESSION_KEYS) {
      expect(tools[key]).toBeDefined();
    }
    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("omits session tools when sessionClient is absent", () => {
    const tools = buildCanonicalTools(makeBaseOpts());

    for (const key of SESSION_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("omits dispatch tools when dispatchManager is absent", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();

    const tools = buildCanonicalTools(opts);

    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("does NOT register dispatch tools when dispatchManager is provided but no dispatchToolsOverride (Phase C removal)", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();

    const tools = buildCanonicalTools(opts);

    // Dispatch tools are restored via dispatchToolsOverride, NOT auto-registered
    // when a dispatchManager is present. Without the override they stay absent.
    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("registers dispatch tools from dispatchToolsOverride", () => {
    const opts = makeBaseOpts();
    const dispatchDispatch = makeDummyTool("dispatch");
    const dispatchOutput = makeDummyTool("dispatch_output");
    opts.dispatchToolsOverride = {
      dispatch: dispatchDispatch,
      dispatch_output: dispatchOutput,
      dispatch_cancel: makeDummyTool("dispatch_cancel"),
      dispatch_metrics: makeDummyTool("dispatch_metrics"),
      dispatch_status: makeDummyTool("dispatch_status"),
    };

    const tools = buildCanonicalTools(opts);

    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeDefined();
    }
    expect(tools.dispatch).toBe(dispatchDispatch);
    expect(tools.dispatch_output).toBe(dispatchOutput);
  });

  it("applies extraTools above dispatchToolsOverride (dispatchToolsOverride has lower precedence)", () => {
    const opts = makeBaseOpts();
    const overrideDispatch = makeDummyTool("override_dispatch");
    const extraDispatch = makeDummyTool("extra_dispatch");
    opts.dispatchToolsOverride = { dispatch: overrideDispatch };
    opts.extraTools = { dispatch: extraDispatch };

    const tools = buildCanonicalTools(opts);

    // extraTools wins over dispatchToolsOverride on overlap.
    expect(tools.dispatch).toBe(extraDispatch);
    expect(tools.dispatch).not.toBe(overrideDispatch);
  });

  it("applies loopToolsOverride above dispatchToolsOverride", () => {
    const opts = makeBaseOpts();
    const overrideSignal = makeDummyTool("override_signal");
    const loopSignal = makeDummyTool("loop_signal");
    opts.dispatchToolsOverride = { signal: overrideSignal };
    opts.loopToolsOverride = { signal: loopSignal };

    const tools = buildCanonicalTools(opts);

    // loopToolsOverride wins over dispatchToolsOverride on overlap.
    expect(tools.signal).toBe(loopSignal);
    expect(tools.signal).not.toBe(overrideSignal);
  });

  it("applies extraTools on top of core tools", () => {
    const opts = makeBaseOpts();
    const extraSignal = makeDummyTool("extra_signal");
    opts.extraTools = {
      signal: extraSignal,
      extra_thing: makeDummyTool("extra_thing"),
    };

    const tools = buildCanonicalTools(opts);

    // extraTools overrides the core signal tool
    expect(tools.signal).toBe(extraSignal);
    expect(tools.extra_thing).toBeDefined();
  });

  it("applies loopToolsOverride last (highest precedence)", () => {
    const opts = makeBaseOpts();
    const extraSignal = makeDummyTool("extra_signal");
    const loopSignal = makeDummyTool("loop_signal");
    opts.extraTools = {
      signal: extraSignal,
    };
    opts.loopToolsOverride = {
      signal: loopSignal,
    };

    const tools = buildCanonicalTools(opts);

    // loopToolsOverride should win over both core and extraTools
    expect(tools.signal).toBe(loopSignal);
    expect(tools.signal).not.toBe(extraSignal);
  });
});
