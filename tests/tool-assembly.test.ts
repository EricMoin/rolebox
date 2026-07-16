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
  "session_inspect",
  "session_changes",
  "session_branch",
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

  it("includes dispatch tools when dispatchManager and resolvedSubagents are provided", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();

    const tools = buildCanonicalTools(opts);

    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeDefined();
    }
  });

  it("uses dispatchToolsOverride when provided", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();
    opts.dispatchToolsOverride = {
      custom_dispatch: makeDummyTool("custom_dispatch"),
    };

    const tools = buildCanonicalTools(opts);

    expect(tools.custom_dispatch).toBeDefined();
    // Standard dispatch keys should NOT be present when override is used
    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("treats empty dispatchToolsOverride ({}) the same as undefined", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();
    opts.dispatchToolsOverride = {};

    const tools = buildCanonicalTools(opts);

    // Empty override should not suppress dispatch tool creation.
    for (const key of DISPATCH_KEYS) {
      expect(tools[key]).toBeDefined();
    }
  });

  it("allows extraTools to override dispatchToolsOverride keys (intentional merge order)", () => {
    const opts = makeBaseOpts();
    opts.sessionClient = makeSessionClient();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();
    opts.dispatchToolsOverride = {
      dispatch: makeDummyTool("dispatch_override"),
    };
    const extraDispatch = makeDummyTool("extra_dispatch");
    opts.extraTools = {
      dispatch: extraDispatch,
    };

    const tools = buildCanonicalTools(opts);

    // extraTools wins over dispatchToolsOverride for overlapping keys.
    expect(tools.dispatch).toBe(extraDispatch);
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
