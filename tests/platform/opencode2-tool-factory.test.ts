/// <reference types="bun-types" />

/**
 * Opencode2ToolFactory — compiles rolebox's CanonicalToolDef into the opencode
 * v2 (Tool.Info) shape the `@opencode/plugin` promise API registers:
 * `{ name, description, input, execute(input, context) => Promise<Tool.Result> }`
 * (node_modules/@opencode/plugin/dist/promise/tool.d.ts:13-15).
 *
 * The cases run the COMPILED object, not a re-declared copy: `input` is driven
 * through the StandardSchemaV1 contract that `Tool.ValueSchema` accepts
 * (node_modules/@opencode/schema/dist/tool.d.ts:32), and the tool context is
 * typed as the real execute() parameter, so a drift in the v2 shape fails the
 * `bun run typecheck:tests` gate instead of silently passing here.
 *
 * No test touches the filesystem, so the working tree stays clean.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  Opencode2ToolFactory,
} from "../../src/platform/adapters/opencode2/tool-factory.ts";
import type { Opencode2CompiledTool } from "../../src/platform/adapters/opencode2/tool-factory.ts";
import type { CanonicalToolContext, CanonicalToolDef, ToolResult } from "../../src/platform/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const DIRECTORY = "/tmp/project";
const WORKTREE = "/tmp/worktree";

/**
 * The v2 tool context the host passes to execute() (…/promise/tool.d.ts:9-12).
 * Its ids are effect brands over string (Tool.Context = sessionID/agent/
 * messageID/id/progress, …/schema/dist/tool.d.ts:10-16), so the fake stamps
 * plain fixture ids through their branded types rather than widening the real
 * contract.
 */
type ToolContext = Parameters<Opencode2CompiledTool["execute"]>[1];

function makeToolContext(overrides: {
  sessionID?: string;
  agent?: string;
  messageID?: string;
  signal?: AbortSignal;
  progress?: ToolContext["progress"];
} = {}): ToolContext {
  return {
    sessionID: (overrides.sessionID ?? "ses_1") as ToolContext["sessionID"],
    agent: (overrides.agent ?? "rolebox--worker") as ToolContext["agent"],
    messageID: (overrides.messageID ?? "msg_1") as ToolContext["messageID"],
    id: "call_1" as ToolContext["id"],
    signal: overrides.signal ?? new AbortController().signal,
    progress: overrides.progress ?? (async () => {}),
  };
}

/** `Tool.ValueSchema` includes StandardSchemaV1 — the surface the host validates through. */
type StandardSchemaLike = {
  "~standard": {
    validate(
      value: unknown,
    ):
      | { value?: unknown; issues?: readonly unknown[] }
      | Promise<{ value?: unknown; issues?: readonly unknown[] }>;
  };
};

interface CompiledEntry {
  tool: Opencode2CompiledTool;
  args: unknown;
  context: CanonicalToolContext | undefined;
  results: ToolResult[];
}

/**
 * Compile one canonical def and return the record the compiled execute fills
 * in AS IT RUNS — `args`/`context`/`results` are read after the call, so they
 * must be read off the returned object (destructuring them up front would
 * snapshot `undefined`).
 */
function compileOne(
  def: CanonicalToolDef,
  options: { name?: string; directory?: string; worktree?: string } = {},
): CompiledEntry {
  const entry: CompiledEntry = { tool: undefined as unknown as Opencode2CompiledTool, args: undefined, context: undefined, results: [] };
  const inner: CanonicalToolDef = {
    description: def.description,
    args: def.args,
    async execute(args, context) {
      entry.args = args;
      entry.context = context;
      const result = await def.execute(args, context);
      entry.results.push(result);
      return result;
    },
  };
  const factory = new Opencode2ToolFactory({
    directory: options.directory ?? DIRECTORY,
    ...(options.worktree !== undefined ? { worktree: options.worktree } : {}),
  });
  const name = options.name ?? "test_tool";
  const compiled = factory.compileAll({ [name]: inner });
  entry.tool = compiled[name] as Opencode2CompiledTool;
  return entry;
}

async function validateInput(
  tool: Opencode2CompiledTool,
  value: unknown,
): Promise<{ value?: unknown; issues?: readonly unknown[] }> {
  const schema = tool.input as StandardSchemaLike;
  return await schema["~standard"].validate(value);
}

// ── Shape ──────────────────────────────────────────────────────────────────

describe("Opencode2ToolFactory shape mapping", () => {
  it("names the compiled tool from the compileAll record key", () => {
    const { tool } = compileOne(
      { description: "reads a file", args: { path: z.string() }, async execute() { return "ok" } },
      { name: "hashline_read" },
    );

    expect(tool.name).toBe("hashline_read");
    expect(tool.description).toBe("reads a file");
    expect(typeof tool.execute).toBe("function");
  });

  it("emits a nameless tool from compile(), which receives no name", () => {
    const factory = new Opencode2ToolFactory({ directory: DIRECTORY });
    const compiled = factory.compile({
      description: "reads a file",
      args: { path: z.string() },
      async execute() {
        return "ok";
      },
    }) as Opencode2CompiledTool;

    expect(compiled.name).toBe("");
    expect(compiled.description).toBe("reads a file");
  });

  it("compiles every entry of a record", () => {
    const factory = new Opencode2ToolFactory({ directory: DIRECTORY });
    const compiled = factory.compileAll({
      tool_a: { description: "a", args: { value: z.number() }, async execute() { return "a" } },
      tool_b: { description: "b", args: {}, async execute() { return "b" } },
    });

    expect(Object.keys(compiled)).toEqual(["tool_a", "tool_b"]);
    expect((compiled["tool_a"] as Opencode2CompiledTool).name).toBe("tool_a");
    expect((compiled["tool_b"] as Opencode2CompiledTool).name).toBe("tool_b");
  });

  it("exposes the canonical args as a StandardSchemaV1-accepted input schema", async () => {
    const { tool } = compileOne({
      description: "searches",
      args: { query: z.string(), limit: z.number().optional() },
      async execute() {
        return "ok";
      },
    });

    const accepted = await validateInput(tool, { query: "needle" });
    expect(accepted.issues).toBeUndefined();
    expect(accepted.value).toEqual({ query: "needle" });

    const rejected = await validateInput(tool, { query: 42 });
    expect(rejected.issues?.length).toBeGreaterThan(0);

    const missing = await validateInput(tool, {});
    expect(missing.issues?.length).toBeGreaterThan(0);
  });
});

// ── Canonical input passthrough ────────────────────────────────────────────

describe("Opencode2ToolFactory input passthrough", () => {
  it("hands the host-validated arguments to the canonical execute unchanged", async () => {
    const entry = compileOne({
      description: "writes",
      args: { path: z.string(), body: z.string() },
      async execute(input) {
        return "wrote " + input.path + ": " + input.body;
      },
    });

    const result = await entry.tool.execute({ path: "a.ts", body: "hello" }, makeToolContext());

    expect(entry.args).toEqual({ path: "a.ts", body: "hello" });
    expect(entry.results).toEqual(["wrote a.ts: hello"]);
    expect(result).toEqual({ content: "wrote a.ts: hello" });
  });
});

// ── Result mapping ─────────────────────────────────────────────────────────

describe("Opencode2ToolFactory result mapping", () => {
  it("maps a string result onto v2 content without losing the text", async () => {
    const { tool } = compileOne({
      description: "greets",
      args: {},
      async execute() {
        return "plain text";
      },
    });

    expect(await tool.execute({}, makeToolContext())).toEqual({ content: "plain text" });
  });

  it("maps an object result onto content + metadata", async () => {
    const { tool } = compileOne({
      description: "reports",
      args: {},
      async execute() {
        return {
          title: "Report",
          output: "the body",
          metadata: { key: "value" },
        };
      },
    });

    expect(await tool.execute({}, makeToolContext())).toEqual({
      content: "the body",
      metadata: { title: "Report", key: "value" },
    });
  });

  it("omits metadata entirely when the canonical result carries none", async () => {
    const { tool } = compileOne({
      description: "reports",
      args: {},
      async execute() {
        return { output: "the body" };
      },
    });

    expect(await tool.execute({}, makeToolContext())).toEqual({ content: "the body" });
  });

  it("turns canonical attachments into v2 file content blocks", async () => {
    const { tool } = compileOne({
      description: "attaches",
      args: {},
      async execute() {
        return {
          output: "see attached",
          attachments: [
            { type: "file", mime: "image/png", url: "file:///tmp/shot.png", filename: "shot.png" },
            { type: "file", mime: "text/plain", url: "file:///tmp/notes.txt" },
          ],
        };
      },
    });

    expect(await tool.execute({}, makeToolContext())).toEqual({
      content: [
        { type: "text", text: "see attached" },
        { type: "file", uri: "file:///tmp/shot.png", mime: "image/png", name: "shot.png" },
        { type: "file", uri: "file:///tmp/notes.txt", mime: "text/plain" },
      ],
    });
  });
});

// ── Context mapping ────────────────────────────────────────────────────────

describe("Opencode2ToolFactory context mapping", () => {
  it("maps the v2 tool context onto CanonicalToolContext", async () => {
    const entry = compileOne(
      { description: "noop", args: {}, async execute() { return "ok" } },
      { directory: DIRECTORY, worktree: WORKTREE },
    );
    const controller = new AbortController();

    await entry.tool.execute(
      {},
      makeToolContext({
        sessionID: "ses_9",
        agent: "rolebox--planner",
        messageID: "msg_9",
        signal: controller.signal,
      }),
    );

    expect(entry.context?.sessionID).toBe("ses_9");
    expect(entry.context?.messageID).toBe("msg_9");
    expect(entry.context?.agent).toBe("rolebox--planner");
    expect(entry.context?.directory).toBe(DIRECTORY);
    expect(entry.context?.worktree).toBe(WORKTREE);
    expect(entry.context?.abort).toBe(controller.signal);
  });

  it("defaults worktree to the factory directory when none is given", async () => {
    const entry = compileOne(
      { description: "noop", args: {}, async execute() { return "ok" } },
      { directory: DIRECTORY },
    );

    await entry.tool.execute({}, makeToolContext());

    expect(entry.context?.worktree).toBe(DIRECTORY);
  });

  it("routes canonical metadata() to the v2 progress reporter", async () => {
    const updates: unknown[] = [];
    const entry = compileOne({
      description: "noop",
      args: {},
      async execute() {
        return "ok";
      },
    });

    await entry.tool.execute({}, makeToolContext({ progress: async (update) => { updates.push(update); } }));
    entry.context?.metadata({ title: "Working", metadata: { step: 1 } });

    expect(updates).toEqual([{ title: "Working", metadata: { step: 1 } }]);
  });

  it("resolves canonical ask() without prompting — v2's tool context has no permission request", async () => {
    const entry = compileOne({ description: "noop", args: {}, async execute() { return "ok" } });

    await entry.tool.execute({}, makeToolContext());

    expect(entry.context).toBeDefined();
    await expect(
      entry.context?.ask({ permission: "terminal", patterns: ["*"], always: [], metadata: {} }),
    ).resolves.toBeUndefined();
  });
});
