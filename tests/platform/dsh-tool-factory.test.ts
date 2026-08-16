/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import type { BuildToolsOptions } from "../../src/platform/tool-assembly.ts";
import { DshToolFactory } from "../../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshDefineToolOptions,
  DshParameterSchemaSpec,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
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
 * `register(definition: ToolDefinition): () => void`). The dsh plugin layer
 * feeds `defineTool(compiled)` into it; here the compiled object is the
 * `DefineToolOptions`-shaped input, so the fake accepts the same structural
 * surface the contract documents (name/description/parameters).
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
    const compiled = factory.compileAll(tools) as Record<string, DshDefineToolOptions>;

    expect(compiled.hashline_read.name).toBe("hashline_read");
    expect(compiled.web_search.name).toBe("web_search");
  });

  it("declares the DSL parameter schema for a real canonical tool (hashline_read)", () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(tools) as Record<string, DshDefineToolOptions>;

    const params = compiled.hashline_read.parameters as DshParameterSchemaSpec;
    const filePath = params.filePath;
    expect(filePath).toBeTypeOf("object");
    expect((filePath as { type?: string }).type).toBe("string");
    expect(filePath.required).toBe(true);
  });

  it("honors exec.signal inside execute (abort before body rejects)", async () => {
    const tools = buildCanonicalTools(makeBaseOpts());
    const factory = new DshToolFactory();
    const compiled = factory.compileAll(tools) as Record<string, DshDefineToolOptions>;

    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));

    const exec = {
      signal: controller.signal,
      callId: "call-1",
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
      DshDefineToolOptions
    >;
    const value = await compiled.probe.execute(
      {},
      { signal: controller.signal, callId: "call-9", agent: { id: "agent-1" } },
    );

    expect(value).toBe(JSON.stringify({ aborted: false, session: "agent-1" }));
  });
});

// ── zod → DSL mapping ─────────────────────────────────────────────────────

describe("DshToolFactory zod → DSL parameter mapping", () => {
  it("maps string/number/int/boolean/enum/array/object/union/optional/default", () => {
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

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshDefineToolOptions>;
    const p = compiled.t.parameters as DshParameterSchemaSpec;

    expect(p.name).toEqual({ type: "string", description: "the name", required: true });
    expect(p.count).toEqual({ type: "integer" });
    expect(p.ratio).toEqual({ type: "number", required: true });
    expect(p.active).toEqual({ type: "boolean", required: true });
    expect(p.mode).toEqual({ type: "string", enum: ["a", "b", "c"], required: true });
    expect(p.tags).toEqual({ type: "array", items: { type: "string" }, required: true });
    expect(p.nested).toEqual({
      type: "object",
      properties: { deep: { type: "string", required: true } },
      additionalProperties: false,
      required: true,
    });
    expect(p.choice).toEqual({
      oneOf: [{ type: "string" }, { type: "number" }],
      required: true,
    });
    // default wrapper → optional, default annotation preserved
    expect(p.limit).toEqual({ type: "number", default: 10 });
  });

  it("maps literal/record/nullable/any to DSL nodes", () => {
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

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshDefineToolOptions>;
    const p = compiled.t.parameters as DshParameterSchemaSpec;

    expect(p.kind).toEqual({ type: "string", const: "fixed", required: true });
    // record → open object; optional wrapper drops required
    expect(p.payload).toEqual({ type: "object", additionalProperties: true });
    // nullable → oneOf with null branch, still required
    expect(p.maybe).toEqual({ oneOf: [{ type: "string" }, { type: "null" }], required: true });
    // any/unknown accept undefined in zod v4 → isOptional() true → not required
    expect(p.free).toEqual({ type: "json" });
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

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshDefineToolOptions>;
    const value = await compiled.t.execute(
      {},
      { signal: new AbortController().signal, callId: "c1" },
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

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshDefineToolOptions>;
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

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshDefineToolOptions>;

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

    const compiled = factory.compileAll({ t: tool }) as Record<string, DshDefineToolOptions>;
    expect(compiled.t.description).toContain("old tool");
    expect(compiled.t.description).toContain("[DEPRECATED] use the new one");
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
