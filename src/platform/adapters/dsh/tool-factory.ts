/**
 * DSH tool factory adapter — implements IToolFactory by compiling canonical
 * rolebox tool definitions (zod args + ToolResult) into
 * `@deepseek-ai/dsh-tools` `defineTool()` definitions.
 *
 * ── Contract basis ─────────────────────────────────────────────────────────
 * Verified against docs/dsh-plugin-contract.md §3.2-§3.5 (tarball citations:
 * `dsh-tools/lib/types/schema.d.ts:177-239` defineTool/DefineToolOptions;
 * `dsh-tools/lib/types/schema.d.ts:9-84` ParameterSchemaSpec/ValueSchemaSpec
 * DSL; `dsh-tools/lib/types/index.d.ts:97-108` ToolOutputDefinition.render;
 * `dsh-tools/lib/types/index.d.ts:196-220` ToolExecutionInput.signal).
 *
 * ── DSL, not raw JSON Schema (parameters) ──────────────────────────────────
 * Tool parameter registration goes through the typed value-schema DSL:
 * `defineTool()` requires `parameters` as a per-property
 * `ParameterSchemaSpec` map (contract §3.2). The contract live-verified that
 * raw JSON-Schema keywords inside `parameters` throw `JsonSchemaError` (§3.2).
 * The raw JSON-schema path (§3.3, `assertSupportedJsonSchema`) exists for
 * EXTERNAL inputs such as `SubagentStartRequest.outputSchema`.
 *
 * ── output.schema: raw JSON-schema subset (verified at runtime) ────────────
 * `output.schema` is the exception: while the TYPE surface
 * (`DefineToolOptions.output.schema`) is typed as a `ValueSchemaSpec`, the
 * real dsh-tools `register()` validates it with `assertSupportedJsonSchema`
 * (the raw JSON-schema subset, §3.3 — object/array/string/number/integer/
 * boolean/null types, annotation-only `{}` = unconstrained JSON) and REJECTS
 * DSL-only nodes such as `{type:"json"}` (`"json"` is not a raw-subset type).
 * This was observed in the packaging subtask's live `dsh` boot test — a
 * `{type:"json"}` output.schema blocks a clean boot. Consequently this
 * adapter emits the raw-subset annotation-only `{}` for `output.schema`
 * (honest for the heterogeneous canonical ToolResult), while `parameters`
 * stays on the DSL above.
 *
 * The zod args → DSL mapping is hand-rolled against the documented DSL subset
 * and verified against the installed zod@4 runtime: each zod node maps to the
 * closest DSL node (string/number/integer/boolean/null/array/object/json/oneOf
 * with per-property `required: true`, `description`, `enum`, `const`, `items`,
 * `additionalProperties`, and `default` annotations where expressible).
 * Unrepresentable zod constructs (tuple, intersection, date, lazy) degrade
 * to the `json` node (unconstrained lossless JSON) — documented, never
 * rejected.
 *
 * ── Imports ────────────────────────────────────────────────────────────────
 * `@deepseek-ai/dsh-tools` is NOT a build-time dependency of this repo (the
 * dsh host provides it at runtime, pinned 0.1.0-rc.6). Following the Pi
 * adapter precedent (`src/platform/adapters/pi/tool-factory.ts` uses loose
 * typing for its optional peer dependency), this adapter emits
 * structurally-compatible plain objects and defines local structural types
 * mirroring the documented DSL. The returned object is opaque per
 * `IToolFactory` ("only the platform runtime interprets it"); the dsh plugin
 * layer feeds it to `ctx.tools.register(defineTool(compiled))`.
 *
 * MUST NOT import any package from the opencode platform SDK or the
 * deepseek dsh-tools SDK.
 */

import type { z } from "zod";
import type { IToolFactory } from "../../ports/tool-factory.ts";
import type {
  CanonicalToolDef,
  CanonicalToolContext,
  ToolResult,
} from "../../types.ts";

// ── Structural dsh-tools types (loose mirrors of the verified DSL) ─────────

/**
 * One author-facing value-schema DSL node (dsh-tools schema.d.ts:20-72).
 * Loose structural mirror — accepts exactly the documented node kinds.
 */
export interface DshValueSchemaSpec {
  type?: "string" | "number" | "integer" | "boolean" | "null" | "array" | "object" | "json";
  /** Exact-one union; ≥2 branches. */
  oneOf?: DshValueSchemaSpec[];
  /** Per-property schema for `type: 'object'`. */
  properties?: DshParameterSchemaSpec;
  /** Object openness (`type: 'object'`); `false` rejects undeclared keys. */
  additionalProperties?: boolean;
  /** Item schema for `type: 'array'`; absent accepts any JSON item. */
  items?: DshValueSchemaSpec;
  /** Allowed scalar values (string/number/boolean/null). */
  enum?: readonly (string | number | boolean | null)[];
  /** Single allowed scalar value. */
  const?: string | number | boolean | null;
  /** Annotation keywords (non-validating). */
  description?: string;
  title?: string;
  default?: unknown;
  examples?: unknown;
}

/**
 * One implicit parameter-root property: a value spec plus per-property
 * requiredness (dsh-tools schema.d.ts:74-76). Requiredness is NEVER a
 * top-level `required` array in the DSL.
 */
export type DshParameterPropertySpec = DshValueSchemaSpec & { required?: true };

/**
 * Tool parameter schema — an implicit open object root keyed by property
 * name (dsh-tools schema.d.ts:81-84).
 */
export type DshParameterSchemaSpec = {
  [key: string]: DshParameterPropertySpec;
};

/** Native text content block (dsh-llm ContentBlock subset). */
export interface DshTextContentBlock {
  type: "text";
  text: string;
}

/**
 * Loose mirror of `ToolRunContext` — the second argument of `defineTool`'s
 * `execute`. Only the fields this adapter reads are typed; the dsh host
 * supplies the real object at runtime.
 */
export interface DshToolRunContext {
  /** REQUIRED caller-owned cancellation (contract §3.5). */
  signal: AbortSignal;
  /** Provider-issued call id. */
  callId?: string;
  rootCallId?: string;
  /** The agent on whose behalf the call runs (scope routing key). */
  agent?: {
    id?: string;
    session?: { id?: string; header?: { cwd?: string } };
  };
  /** Defer context onto this call's result (unused by this adapter). */
  deferContext?(context: unknown): void;
  /** Mark the result terminal for the agent turn (unused). */
  concludeTurn?(): void;
}

/**
 * The compiled output shape: the options object accepted by
 * `defineTool()` from `@deepseek-ai/dsh-tools` (schema.d.ts:178-231).
 * The dsh plugin layer calls `ctx.tools.register(defineTool(compiled))`.
 */
export interface DshDefineToolOptions {
  name: string;
  description: string;
  parameters: DshParameterSchemaSpec;
  output: {
    schema: DshValueSchemaSpec;
    render(args: unknown, value: unknown): DshTextContentBlock[];
  };
  execute(args: Record<string, unknown>, exec: DshToolRunContext): Promise<unknown>;
}

// ── zod → DSL mapping ────────────────────────────────────────────────────────

/** Minimal structural view of zod's internal `_def` (verified on zod@4.1.8). */
interface ZodDef {
  type?: string;
  innerType?: z.ZodTypeAny;
  defaultValue?: unknown;
  entries?: Record<string, unknown>;
  options?: z.ZodTypeAny[];
  element?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
  values?: unknown[];
  out?: z.ZodTypeAny;
  checks?: Array<{ isInt?: boolean; format?: string }>;
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def?: ZodDef })._def ?? {};
}

/** Coerce any zod instance (incl. internal `$ZodType` from ZodRawShape) to
 * the public `ZodTypeAny` surface this mapper reads. */
function asZodType(schema: unknown): z.ZodTypeAny {
  return schema as z.ZodTypeAny;
}

/** Whether a value is lossless JSON (safe as a `default` annotation). */
function isLosslessJson(v: unknown): boolean {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  );
}

/**
 * Map one zod schema to the closest dsh value-schema DSL node.
 * Lossy constructs degrade to `{ type: "json" }` (documented, never rejected).
 */
function zodToDsh(schema: unknown): DshValueSchemaSpec {
  const node = asZodType(schema);
  const def = defOf(node);
  const type = def.type;

  // Annotation: description rides any node; default rides the DSL annotation.
  const ann: DshValueSchemaSpec = {};
  if (typeof node.description === "string") {
    ann.description = node.description;
  }

  switch (type) {
    case "optional":
      return zodToDsh(def.innerType);
    case "default": {
      const inner = zodToDsh(def.innerType);
      if (isLosslessJson(def.defaultValue)) inner.default = def.defaultValue;
      return inner;
    }
    case "nullable":
      return { oneOf: [zodToDsh(def.innerType), { type: "null" }] };
    case "string": {
      const entries = def.entries;
      if (entries && typeof entries === "object") {
        const vals = Object.values(entries).filter((v): v is string => typeof v === "string");
        if (vals.length > 0) return { ...ann, type: "string", enum: vals };
      }
      return { ...ann, type: "string" };
    }
    case "enum": {
      const vals = Object.values(def.entries ?? {});
      const allString = vals.every((v) => typeof v === "string");
      return allString
        ? { ...ann, type: "string", enum: vals as string[] }
        : { ...ann, type: "json" };
    }
    case "number": {
      const isInt =
        (node as unknown as { isInt?: boolean }).isInt === true ||
        def.checks?.some((c) => c.isInt === true || c.format === "safeint") === true;
      return { ...ann, type: isInt ? "integer" : "number" };
    }
    case "boolean":
      return { ...ann, type: "boolean" };
    case "null":
      return { ...ann, type: "null" };
    case "literal": {
      const v = def.values?.[0];
      if (typeof v === "string") return { ...ann, type: "string", const: v };
      if (typeof v === "number")
        return { ...ann, type: Number.isInteger(v) ? "integer" : "number", const: v };
      if (typeof v === "boolean") return { ...ann, type: "boolean", const: v };
      if (v === null) return { ...ann, type: "null", const: null };
      return { ...ann, type: "json" };
    }
    case "array": {
      const items = def.element ? zodToDsh(def.element) : undefined;
      return items ? { ...ann, type: "array", items } : { ...ann, type: "array" };
    }
    case "object": {
      const properties: DshParameterSchemaSpec = {};
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        const childNode = asZodType(child);
        const mapped = zodToDsh(child);
        // Per-property requiredness: optional/default wrappers are optional.
        properties[key] = childNode.isOptional()
          ? mapped
          : { ...mapped, required: true as const };
      }
      return { ...ann, type: "object", properties, additionalProperties: false };
    }
    case "record":
      // z.record → open object; the DSL cannot express a value-type for
      // additionalProperties (boolean only), so the record value schema is
      // dropped by design.
      return { ...ann, type: "object", additionalProperties: true };
    case "union": {
      const options = def.options ?? [];
      if (options.length >= 2) {
        return { ...ann, oneOf: options.map((o) => zodToDsh(o)) };
      }
      return options[0] ? zodToDsh(options[0]) : { ...ann, type: "json" };
    }
    case "pipe":
      // preprocess/transform — declare the output (validated) schema.
      return def.out ? zodToDsh(def.out) : { ...ann, type: "json" };
    case "any":
    case "unknown":
    case "tuple":
    case "intersection":
    case "lazy":
    case "date":
    case "undefined":
    default:
      // Unrepresentable in the DSL subset → unconstrained lossless JSON.
      return { ...ann, type: "json" };
  }
}

/** Map a zod args shape (ZodRawShape) to the DSL parameter map. */
function zodShapeToDsh(shape: z.ZodRawShape): DshParameterSchemaSpec {
  const parameters: DshParameterSchemaSpec = {};
  for (const [key, schema] of Object.entries(shape)) {
    const mapped = zodToDsh(schema);
    // Per-property requiredness at the implicit open-object root: optional /
    // default wrappers are optional, everything else is required.
    parameters[key] = asZodType(schema).isOptional()
      ? mapped
      : { ...mapped, required: true as const };
  }
  return parameters;
}

// ── Canonical value / context mapping ────────────────────────────────────────

/**
 * Render a canonical ToolResult (string | {output, metadata, ...}) as native
 * text content. String results pass through; object results prefer `output`
 * and fall back to a JSON projection.
 */
function toTextContent(value: unknown): DshTextContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (value && typeof value === "object") {
    const output = (value as { output?: unknown }).output;
    if (typeof output === "string") return [{ type: "text", text: output }];
    return [{ type: "text", text: JSON.stringify(value) }];
  }
  return [{ type: "text", text: String(value) }];
}

/**
 * Build a CanonicalToolContext from the dsh ToolRunContext.
 *
 * The canonical contract's `abort` is backed by the REQUIRED `exec.signal`
 * (contract §3.5: async tool bodies must observe or forward `exec.signal`).
 * Identity fields are extracted by convention with fallbacks (Pi-adapter
 * style): the agent's session id / call id stand in for session/message ids,
 * and the session header's `cwd` for directory/worktree.
 *
 * `metadata()` and `ask()` have NO dsh ToolRunContext equivalent — dsh gates
 * permissions via the `tools/pre-execute` ToolGuard pipeline, not per-call
 * callbacks — so they are documented no-ops.
 */
function toCanonicalContext(exec: DshToolRunContext): CanonicalToolContext {
  const agent = exec.agent;
  const session = agent?.session;
  const cwd = session?.header?.cwd;
  return {
    sessionID: String(session?.id ?? agent?.id ?? exec.callId ?? exec.rootCallId ?? ""),
    messageID: String(exec.callId ?? exec.rootCallId ?? ""),
    agent: String(agent?.id ?? ""),
    directory: typeof cwd === "string" ? cwd : "",
    worktree: typeof cwd === "string" ? cwd : "",
    abort: exec.signal,
    metadata() {
      // No dsh ToolRunContext seam for per-call metadata — documented no-op.
    },
    async ask() {
      // dsh permission gating lives in the tools/pre-execute ToolGuard
      // pipeline, not in the tool body — documented no-op.
    },
  };
}

/** Deprecation notice ride the description (dsh has no native deprecation
 * field; the canonical contract promises the LLM sees a notice). */
function withDeprecation(
  description: string,
  deprecated: CanonicalToolDef["deprecated"],
): string {
  if (!deprecated) return description;
  if (deprecated === true) return `${description}\n\n[DEPRECATED]`;
  return `${description}\n\n[DEPRECATED] ${deprecated.message}`;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * IToolFactory adapter for the dsh platform.
 *
 * Compiles CanonicalToolDefs into dsh-tools `defineTool()` options objects
 * (`DshDefineToolOptions`): zod args → ParameterSchemaSpec DSL, output schema
 * as the lossless-JSON DSL node, a text render, and an execute that maps
 * `exec.signal` → `context.abort` and returns the canonical ToolResult.
 *
 * Prefer compileAll() over compile(): dsh tool definitions require a `name`,
 * which only the record key provides (same constraint as the Pi adapter).
 */
export class DshToolFactory implements IToolFactory {
  compile<Args extends z.ZodRawShape>(def: CanonicalToolDef<Args>): unknown {
    // compile() receives no name (CanonicalToolDef carries none); compileAll()
    // supplies it from the record key. "" marks "name unknown to the factory".
    return this.#compileNamed("", def);
  }

  compileAll(defs: Record<string, CanonicalToolDef>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      result[name] = this.#compileNamed(name, def);
    }
    return result;
  }

  /** Internal — compile one canonical def with an explicit tool name. */
  #compileNamed<Args extends z.ZodRawShape>(
    name: string,
    def: CanonicalToolDef<Args>,
  ): DshDefineToolOptions {
    const parameters = zodShapeToDsh(def.args);

    return {
      name,
      description: withDeprecation(def.description, def.deprecated),
      parameters,
      output: {
        // ToolResult is heterogeneous (string | {title?, output, metadata?,
        // attachments?}) — the raw-subset annotation-only schema `{}`
        // (unconstrained JSON, contract §3.3) is the honest declaration.
        // MUST NOT use the DSL `{type:"json"}` node here: the real dsh-tools
        // register() validates `output.schema` with assertSupportedJsonSchema
        // (raw JSON-schema subset, §3.3) and rejects `"json"` as an
        // unsupported raw type — that rejection blocks a clean `dsh` boot
        // (observed in the packaging subtask's live boot test).
        schema: {},
        render: (_args, value) => toTextContent(value),
      },
      async execute(args, exec) {
        // Honor exec.signal: surface caller cancellation before invoking the
        // canonical body and forward the signal as context.abort.
        if (exec.signal?.aborted) {
          throw exec.signal.reason ?? new Error("tool call aborted");
        }
        const context = toCanonicalContext(exec);
        const result = await def.execute(args as never, context);
        return result; // canonical ToolResult — lossless JSON
      },
    };
  }
}
