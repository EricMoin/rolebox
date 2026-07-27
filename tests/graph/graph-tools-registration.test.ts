/**
 * Graph Execution Engine v2 — `graph_*` Tool Registration Tests
 *
 * Phase 4, Subtask 6. Verifies Phase A coexistence: `createGraphTools` wires
 * zod arg schemas around the GraphToolSet, and `buildCanonicalTools` registers
 * all eight `graph_*` tools (when a dispatch manager is present) WITHOUT
 * overriding any existing `dispatch_*` / `loop_*` / core tool.
 *
 * `graph_approve` is the Phase C (Plan B) GAP-2 fill: a parent-facing
 * approve/reject surface routing to the engine's internal `approveNode` /
 * `rejectNode` (the migration target of `dispatch_approve` / `dispatch_reject`).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import type { BuildToolsOptions } from "../../src/platform/tool-assembly.ts";
import { createGraphTools } from "../../src/graph/tools/index.ts";
import type { ResolvedRole } from "../../src/types.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";
import { defaultCapabilities } from "../../src/platform/capabilities.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeResolvedRole(): ResolvedRole {
  return {
    id: "test-role",
    config: { name: "Test Role", description: "A minimal test role", prompt: "You are a test role." },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  } as ResolvedRole;
}

function makeDispatchManager(): DispatchManager {
  return {
    getTasksByParent: () => [],
    getTask: () => undefined,
    getEventState: () => new Map(),
  } as unknown as DispatchManager;
}

function makeBaseOpts(): BuildToolsOptions {
  return {
    resolvedRoles: [makeResolvedRole()],
    directory: "/tmp/test",
    capabilities: defaultCapabilities(),
  };
}

const GRAPH_KEYS = [
  "graph_create",
  "graph_add_node",
  "graph_add_edge",
  "graph_add_loop",
  "graph_run",
  "graph_status",
  "graph_cancel",
  "graph_approve",
];

// ── createGraphTools: schema shape ──────────────────────────────────────────

describe("createGraphTools", () => {
  it("returns exactly the 8 graph_* tools", () => {
    const tools = createGraphTools(makeDispatchManager(), { directory: "/tmp" });
    expect(Object.keys(tools).sort()).toEqual([...GRAPH_KEYS].sort());
  });

  it("wraps each tool with a zod args schema and an execute fn", () => {
    const tools = createGraphTools(makeDispatchManager(), { directory: "/tmp" });
    for (const def of Object.values(tools)) {
      expect(typeof def.description).toBe("string");
      expect(def.args).toBeDefined();
      expect(typeof def.execute).toBe("function");
    }
  });

  it("graph_add_node exposes required + optional zod args", () => {
    const { graph_add_node } = createGraphTools(undefined, { directory: "/tmp" });
    expect(graph_add_node.args.graph_id).toBeInstanceOf(z.ZodString);
    expect(graph_add_node.args.id).toBeInstanceOf(z.ZodString);
    expect(graph_add_node.args.agent).toBeInstanceOf(z.ZodString);
    expect(graph_add_node.args.prompt).toBeInstanceOf(z.ZodString);
    expect(graph_add_node.args.join).toBeInstanceOf(z.ZodOptional);
    expect(graph_add_node.args.needs_approval).toBeInstanceOf(z.ZodOptional);
    expect(graph_add_node.args.budget).toBeInstanceOf(z.ZodOptional);
  });

  it("graph_status exposes a summary/tree/json format enum", () => {
    const { graph_status } = createGraphTools(undefined, { directory: "/tmp" });
    const format = graph_status.args.format as z.ZodType<any>;
    expect(format).toBeInstanceOf(z.ZodOptional);
    // Parsing exercises the inner enum: valid values pass, invalid values reject.
    const inner = (format as z.ZodOptional<z.ZodTypeAny>)._def.innerType as z.ZodEnum<any>;
    expect(inner.options).toEqual(["summary", "tree", "json"]);
    expect(inner.parse("tree")).toBe("tree");
    expect(() => inner.parse("invalid")).toThrow();
    expect(() => inner.parse("json")).not.toThrow();
  });

  it("executes graph_create end-to-end and returns a graph_id", async () => {
    const { graph_create } = createGraphTools(undefined, { directory: "/tmp" });
    const out = await graph_create.execute({ name: "reg-test" }, makeContext());
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out as string);
    expect(parsed.graph_id).toBe("reg-test");
    expect(parsed.name).toBe("reg-test");
  });
});

// ── buildCanonicalTools: Phase A coexistence ────────────────────────────────

describe("buildCanonicalTools graph registration (Phase A coexistence)", () => {
  it("registers all 7 graph_* tools when a dispatchManager is present", () => {
    const opts = makeBaseOpts();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();

    const tools = buildCanonicalTools(opts);

    for (const key of GRAPH_KEYS) {
      expect(tools[key]).toBeDefined();
    }
  });

  it("omits graph_* tools when no dispatchManager is present", () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    for (const key of GRAPH_KEYS) {
      expect(tools[key]).toBeUndefined();
    }
  });

  it("produces exactly 7 graph_* keys and coexists with loop_*/core keys", () => {
    const opts = makeBaseOpts();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();
    // Add a loop tool via loopToolsOverride to prove graph merge coexists.
    opts.loopToolsOverride = {
      loop_start: makeDummyTool("loop_start"),
    };

    const tools = buildCanonicalTools(opts);

    const graphKeys = Object.keys(tools).filter((k) => k.startsWith("graph_"));
    expect(graphKeys.sort()).toEqual([...GRAPH_KEYS].sort());

    // loop_* and core keys unchanged — none repurposed by the graph merge.
    for (const key of ["loop_start", "signal"]) {
      expect(tools[key]).toBeDefined();
    }
  });

  it("keeps extraTools / loopToolsOverride precedence intact (graph merge is additive, not overriding)", () => {
    const opts = makeBaseOpts();
    opts.dispatchManager = makeDispatchManager();
    opts.resolvedSubagents = new Map();
    const extraSignal = makeDummyTool("extra_signal");
    const loopSignal = makeDummyTool("loop_signal");
    opts.extraTools = { signal: extraSignal };
    opts.loopToolsOverride = { signal: loopSignal };

    const tools = buildCanonicalTools(opts);

    // Precedence among the pre-existing tools is unchanged by the graph merge.
    expect(tools.signal).toBe(loopSignal);
    expect(tools.signal).not.toBe(extraSignal);
    // And the graph tools were added alongside, not clobbering anything.
    for (const key of GRAPH_KEYS) {
      expect(tools[key]).toBeDefined();
    }
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDummyTool(name: string) {
  return defineTool({
    description: `Dummy ${name} tool for tests`,
    args: { text: z.string().optional() },
    async execute() {
      return `dummy ${name}`;
    },
  });
}

function makeContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "test-agent",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}
