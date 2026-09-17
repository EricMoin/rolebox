/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import type { BuildToolsOptions } from "../../src/platform/tool-assembly.ts";
import {
  DshToolFactory,
  DshReservedToolNameError,
  DSH_RESERVED_RUN_CODE_NAME,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshToolDefinition,
  DshToolRunContext,
  DshJsonSchema,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { DshContentBlock } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import { defaultCapabilities } from "../../src/platform/capabilities.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";
import type { CanonicalToolDef } from "../../src/platform/types.ts";
import type { ResolvedRole } from "../../src/types.ts";

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

/**
 * Fake tools registry emulating the verified `ctx.tools.register(definition)`
 * surface from the dsh contract (dsh-tools/lib/types/index.d.ts:603 —
 * `register(definition: ToolDefinition): () => void`). The real register()
 * stores the definition raw (no defineTool() compile step), so the compiled
 * object is registered directly; the fake accepts the same structural surface.
 */
function makeFakeToolsRegistry() {
  const registered: Array<Record<string, unknown>> = [];
  return {
    registered,
    register(definition: Record<string, unknown>): () => void {
      registered.push(definition);
      return () => {
        const i = registered.indexOf(definition);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  };
}

// ── Type-level contract regression ───────────────────────────────────
// rc.6 declares `callId`, `deferContext`, and `concludeTurn` REQUIRED on the
// real ToolRunContext (dsh-tools/lib/types/index.d.ts:197,290,299). The
// conditional type below fails to compile if any is loosened to optional
// again, and the `satisfies` literal pins the required surface. Both are
// erased at runtime; `tsc --noEmit` gates them.
type _IsRequired<T, K extends keyof T> = undefined extends T[K] ? false : true;
type _AllRequired<T extends readonly true[]> = T;
type _DshToolRunContextRequired = _AllRequired<
  [
    _IsRequired<DshToolRunContext, "callId">,
    _IsRequired<DshToolRunContext, "deferContext">,
    _IsRequired<DshToolRunContext, "concludeTurn">,
  ]
>;

const dshToolRunContextFixture = {
  signal: new AbortController().signal,
  callId: "call-1",
  deferContext: (_context: unknown) => {},
  concludeTurn: () => {},
} satisfies DshToolRunContext;

describe("dsh tool-factory type contract", () => {
  it("keeps callId/deferContext/concludeTurn required on DshToolRunContext", () => {
    // The assertion above is compile-time; this runtime check keeps the file
    // exercised so the type block cannot be silently deleted.
    expect(dshToolRunContextFixture.callId).toBe("call-1");
    expect(dshToolRunContextFixture.deferContext).toBeTypeOf("function");
    expect(dshToolRunContextFixture.concludeTurn).toBeTypeOf("function");
  });
});

// ── compileAll over buildCanonicalTools ───────────────────────────────────

describe("DshToolFactory.compileAll(buildCanonicalTools(...))", () => {
  it("registers >= 1 tool into a fake tools registry, each with name/description/parameters", () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(tools);
    const registry = makeFakeToolsRegistry();

    for (const def of Object.values(compiled)) {
      registry.register(def as Record<string, unknown>);
    }

    expect(registry.registered.length).toBeGreaterThanOrEqual(1);

    for (const tool of registry.registered) {
      const t = tool as { name?: unknown; description?: unknown; parameters?: unknown };
      expect(t.name).toBeTypeOf("string");
      expect(t.description).toBeTypeOf("string");
      expect((t.description as string).length).toBeGreaterThan(0);
      expect(t.parameters).toBeTypeOf("object");
    }
  });

  it("uses the record key as the tool name", () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(tools) as Record<string, DshToolDefinition>;

    expect(compiled.hashline_read.name).toBe("hashline_read");
    expect(compiled.web_search.name).toBe("web_search");
  });

  it("declares standard JSON Schema for a real canonical tool (hashline_read)", () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(tools) as Record<string, DshToolDefinition>;

    // Wire-ready JSON Schema: object root with a top-level `required` ARRAY —
    // never the author DSL's per-property `required: true`.
    const params = compiled.hashline_read.parameters as DshJsonSchema;
    expect(params.type).toBe("object");
    const filePath = params.properties?.filePath;
    expect(filePath).toBeTypeOf("object");
    expect(filePath?.type).toBe("string");
    expect(params.required).toContain("filePath");
    expect(filePath).not.toHaveProperty("required");
  });

  it("honors exec.signal inside execute (abort before body rejects)", async () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(tools) as Record<string, DshToolDefinition>;

    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));

    const exec: DshToolRunContext = {
      signal: controller.signal,
      callId: "call-1",
      deferContext: () => {},
      concludeTurn: () => {},
    };

    await expect(
      compiled.hashline_read.execute({ filePath: "/tmp/x" }, exec),
    ).rejects.toThrow("caller cancelled");
  });

  it("forwards exec.signal as context.abort to the canonical body", async () => {
    const factory = new DshToolFactory();
    const controller = new AbortController();

    const probeTool = defineTool({
      description: "probe",
      args: { x: z.string().optional() },
      async execute(_args, context) {
        return JSON.stringify({ aborted: context.abort.aborted, session: context.sessionID });
      },
    });

    const compiled = factory.compileAll({ probe: probeTool }) as Record<
      string,
      DshToolDefinition
    >;
    const value = await compiled.probe.execute(
      {},
      {
        signal: controller.signal,
        callId: "call-9",
        agent: { id: "agent-1" },
        deferContext: () => {},
        concludeTurn: () => {},
      },
    );

    // The probe body returns a JSON-object string; the adapter wraps it as the
    // structured envelope (see the JSON-string result describe block) while
    // `.output` preserves the exact text — signal forwarding still verified.
    expect(value).toEqual({
      output: JSON.stringify({ aborted: false, session: "agent-1" }),
      aborted: false,
      session: "agent-1",
    });
  });
});

// ── zod → DSL mapping ─────────────────────────────────────────────────────

describe("DshToolFactory zod → register-ready JSON Schema mapping", () => {
  it("maps string/number/int/boolean/enum/array/object/union/optional/default to raw JSON Schema", () => {
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "map test",
      args: {
        name: z.string().describe("the name"),
        count: z.number().int().optional(),
        ratio: z.number(),
        active: z.boolean(),
        mode: z.enum(["a", "b", "c"]),
        tags: z.array(z.string()),
        nested: z.object({ deep: z.string() }),
        choice: z.union([z.string(), z.number()]),
        limit: z.number().default(10),
      },
      async execute() {
        return "ok";
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const p = compiled.t.parameters as DshJsonSchema;
    const props = p.properties ?? {};

    expect(p.type).toBe("object");
    // Properties carry NO per-property `required` (that key leaked onto the wire).
    expect(props.name).toEqual({ type: "string", description: "the name" });
    expect(props.count).toEqual({ type: "integer" });
    expect(props.ratio).toEqual({ type: "number" });
    expect(props.active).toEqual({ type: "boolean" });
    expect(props.mode).toEqual({ type: "string", enum: ["a", "b", "c"] });
    expect(props.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(props.nested).toEqual({
      type: "object",
      properties: { deep: { type: "string" } },
      additionalProperties: false,
      required: ["deep"],
    });
    expect(props.choice).toEqual({ oneOf: [{ type: "string" }, { type: "number" }] });
    // default wrapper → optional value, default annotation preserved
    expect(props.limit).toEqual({ type: "number", default: 10 });

    // Requiredness is one top-level array; optional/default entries are absent.
    expect(p.required).toEqual(["name", "ratio", "active", "mode", "tags", "nested", "choice"]);
  });

  it("maps literal/record/nullable/any to raw JSON Schema nodes", () => {
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "map test 2",
      args: {
        kind: z.literal("fixed"),
        payload: z.record(z.string(), z.unknown()).optional(),
        maybe: z.string().nullable(),
        free: z.any(),
      },
      async execute() {
        return "ok";
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const p = compiled.t.parameters as DshJsonSchema;
    const props = p.properties ?? {};

    expect(props.kind).toEqual({ type: "string", const: "fixed" });
    // record → open object; optional wrapper drops it from `required`
    expect(props.payload).toEqual({ type: "object", additionalProperties: true });
    // nullable → oneOf with null branch, still required
    expect(props.maybe).toEqual({ oneOf: [{ type: "string" }, { type: "null" }] });
    // any/unknown accept undefined in zod v4 → isOptional() true → not required;
    // an author `json` node compiles to the annotation-only `{}` (unconstrained)
    expect(props.free).toEqual({});

    expect(p.required).toEqual(["kind", "maybe"]);
  });
});

// ── output.render / execute value contract ────────────────────────────────

describe("DshToolFactory output contract", () => {
  it("returns the canonical ToolResult value from execute", async () => {
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "returns object result",
      args: {},
      async execute() {
        return { title: "done", output: "all good", metadata: { n: 1 } };
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const value = await compiled.t.execute(
      {},
      {
        signal: new AbortController().signal,
        callId: "c1",
        deferContext: () => {},
        concludeTurn: () => {},
      },
    );
    expect(value).toEqual({ title: "done", output: "all good", metadata: { n: 1 } });
  });

  it("emits output.schema as the raw JSON-schema subset ({} unconstrained), not the DSL json node", () => {
    // The real dsh-tools register() validates output.schema with
    // assertSupportedJsonSchema (raw subset, contract §3.3) and rejects the
    // DSL-only `{type:"json"}` node — a `{type:"json"}` output.schema blocked
    // a clean `dsh` boot in the packaging subtask's live boot test. The
    // adapter must emit an annotation-only `{}` (unconstrained JSON) instead.
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "output schema subset test",
      args: {},
      async execute() {
        return "ok";
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    expect(compiled.t.output.schema).toEqual({});
    // And it must NOT be the DSL node (which register() would reject).
    expect(compiled.t.output.schema).not.toEqual({ type: "json" });
  });

  it("render returns text content blocks for string and object values", () => {
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "render test",
      args: {},
      async execute() {
        return "plain string";
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;

    const asString = compiled.t.output.render({}, "hello");
    expect(asString).toEqual([{ type: "text", text: "hello" }]);

    const asObject = compiled.t.output.render({}, { output: "obj text" });
    expect(asObject).toEqual([{ type: "text", text: "obj text" }]);

    const asStructured = compiled.t.output.render({}, { metadata: { n: 2 } });
    expect(asStructured[0].type).toBe("text");
    expect(typeof asStructured[0].text).toBe("string");
  });

  it("deprecation notice rides the description", () => {
    const factory = new DshToolFactory();
    // The port's defineTool() input omits `deprecated`; the canonical def type
    // carries it, so construct the def directly to exercise the notice path.
    const tool: CanonicalToolDef = {
      description: "old tool",
      deprecated: { since: "1.0", message: "use the new one" },
      args: {},
      async execute() {
        return "ok";
      },
    };

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    expect(compiled.t.description).toContain("old tool");
    expect(compiled.t.description).toContain("[DEPRECATED] use the new one");
  });
});

// ── JSON-string result → structured envelope (dsh run_code ergonomics) ─────
// Canonical bodies that return a JSON-object string (the graph tools' `json()`
// output) must stay byte-identical as model-visible text while ALSO resolving
// to a structured value for Code Mode callers. The dsh adapter wraps such a
// string as `{ output: <string>, ...parsed }`; toTextContent prefers `.output`,
// so the rendered text is unchanged.

describe("DshToolFactory JSON-string result envelope", () => {
  function makeExec(): DshToolRunContext {
    return {
      signal: new AbortController().signal,
      callId: "call-1",
      deferContext: () => {},
      concludeTurn: () => {},
    };
  }

  async function executeString(raw: string): Promise<{
    value: unknown;
    rendered: DshContentBlock[];
  }> {
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "json-string probe",
      args: {},
      async execute() {
        return raw;
      },
    });
    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const value = await compiled.t.execute({}, makeExec());
    return { value, rendered: compiled.t.output.render({}, value) };
  }

  it("spreads a JSON-object string into the envelope with identical rendered text", async () => {
    const raw = JSON.stringify({ graph_id: "g-1", status: "created" });
    const { value, rendered } = await executeString(raw);

    // Structured value: Code Mode can read `created.graph_id`.
    expect(value).toEqual({ output: raw, graph_id: "g-1", status: "created" });
    expect((value as { graph_id: string }).graph_id).toBe("g-1");
    // Model-visible text is byte-identical to the original string.
    expect(rendered).toEqual([{ type: "text", text: raw }]);
  });

  it("passes a plain non-JSON string through unchanged", async () => {
    const raw = "not json { oops";
    const { value, rendered } = await executeString(raw);

    expect(value).toBe(raw);
    expect(rendered).toEqual([{ type: "text", text: raw }]);
  });

  it("passes a parsed object that already owns an `output` key through unchanged", async () => {
    const raw = JSON.stringify({ output: "inner", other: 1 });
    const { value, rendered } = await executeString(raw);

    expect(value).toBe(raw);
    expect(rendered).toEqual([{ type: "text", text: raw }]);
  });

  it("passes a JSON array string through unchanged", async () => {
    const raw = JSON.stringify([1, 2, 3]);
    const { value, rendered } = await executeString(raw);

    expect(value).toBe(raw);
    expect(rendered).toEqual([{ type: "text", text: raw }]);
  });
});

// ── Incoming args validation (subtask 6: root-cause fix for loop_start) ────
// The dsh host registers `parameters` as raw JSON Schema for the wire and does
// NOT parse them, so the adapter must safeParse incoming args itself. Before
// the fix, `def.execute(args as never, …)` passed raw args with required args
// unenforced and defaults unapplied — a missing required arg surfaced as an
// opaque raw TypeError (observed live: loop_start → "Cannot read properties of
// undefined (reading 'replace')"). The adapter now returns a host-native
// correction STRING; it is NON-strict (strips unknown keys) unlike the Pi path.

describe("DshToolFactory incoming args validation", () => {
  function makeExec(): DshToolRunContext {
    return {
      signal: new AbortController().signal,
      callId: "call-1",
      deferContext: () => {},
      concludeTurn: () => {},
    };
  }

  it("returns a correction string naming the missing required property instead of a TypeError", async () => {
    const factory = new DshToolFactory();
    const tool = defineTool({
      description: "requires a prompt",
      args: { prompt: z.string() },
      async execute(args) {
        // Pre-fix, a missing `prompt` reached this line as undefined and the
        // `.replace` call threw the raw TypeError seen in production.
        return (args.prompt as string).replace("a", "b");
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const value = await compiled.t.execute({}, makeExec());

    expect(typeof value).toBe("string");
    expect(value).toBe('invalid arguments: missing required property "prompt"');
    expect(value as string).not.toContain("Cannot read properties of undefined");
  });

  it("applies a zod .default() so the tool body sees the default when the arg is omitted", async () => {
    const factory = new DshToolFactory();
    const seen: Array<Record<string, unknown>> = [];
    const tool = defineTool({
      description: "default probe",
      args: { name: z.string(), count: z.number().default(10) },
      async execute(args) {
        seen.push(args as unknown as Record<string, unknown>);
        return JSON.stringify(args);
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const value = await compiled.t.execute({ name: "x" }, makeExec());

    // The tool body observed the applied default (not `undefined`).
    expect(seen[0]).toEqual({ name: "x", count: 10 });
    // JSON-object string → structured envelope; `.output` is byte-identical.
    expect(value).toEqual({
      output: JSON.stringify({ name: "x", count: 10 }),
      name: "x",
      count: 10,
    });
  });

  it("produces byte-identical output for a valid call, including JSON-object result wrapping", async () => {
    const raw = JSON.stringify({ graph_id: "g-1", status: "created" });
    const factory = new DshToolFactory();
    const wrapped = defineTool({
      description: "json-string probe",
      args: { name: z.string() },
      async execute() {
        return raw;
      },
    });
    const plain = defineTool({
      description: "plain probe",
      args: { name: z.string() },
      async execute(args) {
        return `hello ${args.name}`;
      },
    });

    const compiled = factory.compileAll({ wrapped, plain }) as Record<string, DshToolDefinition>;
    const exec = makeExec();

    expect(await compiled.wrapped.execute({ name: "ignored" }, exec)).toEqual({
      output: raw,
      graph_id: "g-1",
      status: "created",
    });
    expect(await compiled.plain.execute({ name: "world" }, exec)).toBe("hello world");
  });

  it("strips (does not reject) unknown args — non-strict divergence from the Pi .strict() path", async () => {
    const factory = new DshToolFactory();
    const seen: Array<Record<string, unknown>> = [];
    const tool = defineTool({
      description: "non-strict probe",
      args: { name: z.string() },
      async execute(args) {
        seen.push(args as unknown as Record<string, unknown>);
        return "ok";
      },
    });

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshToolDefinition>;
    const value = await compiled.t.execute({ name: "x", extra: 1 }, makeExec());

    expect(value).toBe("ok");
    expect(seen[0]).toEqual({ name: "x" });
    expect(seen[0]).not.toHaveProperty("extra");
  });
});

// ── Reserved tool-name guard (subtask 3: dsh reserves `run_code`) ──────────
// dsh reserves `run_code` unconditionally for its PTC/code-mode presentation
// transport, and `ctx.tools.register()` throws on the collision
// (dsh 0.1.5-rc.1 packages/core/tools/src/index.ts:1044-1046). The factory
// refuses such a name at compile time — BEFORE registration.

describe("DshToolFactory reserved run_code guard", () => {
  function makeTool(): CanonicalToolDef {
    return defineTool({
      description: "reserved-name probe",
      args: {},
      async execute() {
        return "ok";
      },
    });
  }

  it("throws a named DshReservedToolNameError when compiling a tool named run_code", () => {
    const factory = new DshToolFactory();
    expect(() => factory.compileAll({ run_code: makeTool() })).toThrow(
      DshReservedToolNameError,
    );
  });

  it("names the reserved-transport reason in the error message", () => {
    const factory = new DshToolFactory();
    let caught: unknown;
    try {
      factory.compileAll({ run_code: makeTool() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DshReservedToolNameError);
    const err = caught as DshReservedToolNameError;
    expect(err.name).toBe("DshReservedToolNameError");
    expect(err.toolName).toBe(DSH_RESERVED_RUN_CODE_NAME);
    expect(err.message).toContain("run_code");
    expect(err.message).toMatch(/reserved/i);
    expect(err.message).toMatch(/PTC|code-mode/i);
  });

  it("rejects BEFORE registration — register() is never reached", () => {
    const factory = new DshToolFactory();
    let registered = 0;
    const registry = {
      register(): () => void {
        registered++;
        return () => {};
      },
    };
    expect(() => {
      const compiled = factory.compileAll({ run_code: makeTool() });
      registry.register();
      void compiled;
    }).toThrow(DshReservedToolNameError);
    expect(registered).toBe(0);
  });

  it("does not reject a non-reserved tool name (negative control)", () => {
    const factory = new DshToolFactory();
    expect(() => factory.compileAll({ not_run_code: makeTool() })).not.toThrow();
  });

  it("grep assertion: no existing rolebox tool name collides with run_code", () => {
    // Grep the tool-registry sources the dsh plugin merges
    // (src/entries/dsh.ts: buildCanonicalTools ∪ createGraphTools ∪
    // createLoopTools) for their declared tool names, and assert none is the
    // reserved `run_code`.
    const registrySources: Array<{ path: string; pattern: RegExp }> = [
      {
        path: "src/platform/tool-assembly.ts",
        pattern: /^\s*tools\.([A-Za-z_][A-Za-z0-9_]*)\s*=/gm,
      },
      {
        path: "src/graph/tools/index.ts",
        pattern: /^\s+(graph_[a-z_]+)\s*:\s*create/gm,
      },
      {
        path: "src/loop/loop-tools.ts",
        pattern: /^\s+(loop_[a-z_]+)\s*:\s*create/gm,
      },
    ];
    const names = new Set<string>();
    for (const { path, pattern } of registrySources) {
      const source = readFileSync(resolve(import.meta.dir, "../..", path), "utf-8");
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
    // Sanity: the scan actually found the rolebox tool registry.
    expect(names.size).toBeGreaterThanOrEqual(20);
    expect([...names]).not.toContain(DSH_RESERVED_RUN_CODE_NAME);
  });
});

// ── Import hygiene ────────────────────────────────────────────────────────

describe("dsh tool-factory adapter import hygiene", () => {
  const FILE = resolve(import.meta.dir, "../../src/platform/adapters/dsh/tool-factory.ts");

  function extractImportSpecifiers(source: string): string[] {
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  it("contains no @opencode-ai/* or @deepseek-ai/* imports", () => {
    const specifiers = extractImportSpecifiers(readFileSync(FILE, "utf-8"));
    const forbidden = specifiers.filter(
      (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
    );
    expect(forbidden, `${FILE} imports platform SDK packages`).toEqual([]);
  });
});
