/**
 * DSH tool factory adapter — implements IToolFactory by compiling canonical
 * rolebox tool definitions (zod args + ToolResult) into register-ready
 * `@deepseek-ai/dsh-tools` `ToolDefinition` inputs (`DshToolDefinition`).
 *
 * ── Contract basis ─────────────────────────────────────────────────────────
 * Verified against docs/dsh-plugin-contract.md §3.2-§3.5 (tarball citations:
 * `dsh-tools/lib/types/index.d.ts:106-124` ToolDefinition register input;
 * `dsh-tools/lib/types/schema.d.ts:177-239` defineTool/DefineToolOptions;
 * `dsh-tools/lib/types/schema.d.ts:9-84` ParameterSchemaSpec/ValueSchemaSpec
 * DSL; `dsh-tools/lib/types/index.d.ts:97-108` ToolOutputDefinition.render;
 * `dsh-tools/lib/types/index.d.ts:196-220` ToolExecutionInput.signal).
 *
 * ── register-ready raw JSON Schema (parameters AND output.schema) ───────────
 * The dsh plugin registers each compiled tool via `ctx.tools.register(def)`
 * DIRECTLY — it does NOT wrap the definition in `defineTool()` (the adapter
 * MUST NOT value-import `@deepseek-ai/dsh-tools`; type-only imports erase at
 * build time — see ── Imports ──). This is load-bearing: unlike
 * `defineTool()`, `register()` performs NO `parameters` compilation — verified
 * at source, it only asserts `output.schema` and then stores the definition
 * object as-is (dsh-tools lib/index.js:2755-2763). Only `defineTool()`
 * (lib/index.js:836-845) compiles the author DSL into raw JSON Schema via
 * `parameterSchemaSpecToJsonSchema`.
 *
 * Therefore BOTH `parameters` and `output.schema` MUST already be standard
 * JSON Schema (the enforced raw subset, §3.3): object/array/string/number/
 * integer/boolean/null types, annotation-only `{}` = unconstrained JSON.
 * Downstream consumers read them as JSON Schema — the LLM request serializer
 * onto the wire, and Code Mode's SDK renderers (`jsonSchemaToTs`,
 * lib/index.js:1613/:2320). Emitting the author DSL here (per-property
 * `required:true` with no top-level `required` array) leaked onto the wire and
 * DeepSeek rejected the request with HTTP 400 "Invalid schema for function …".
 *
 * Consequently this adapter emits register-ready raw JSON Schema for
 * `parameters` by compiling its internal author-DSL mapping exactly as
 * `defineTool()` would (see `dslParameterMapToJsonSchema`), and the
 * annotation-only `{}` for the heterogeneous canonical ToolResult
 * `output.schema`.
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
 * `@deepseek-ai/dsh-tools` IS a declared devDependency of this repo
 * (`package.json`), so its TYPES may be imported type-only — such an import
 * is erased at build time, and the dsh host provides the module at runtime,
 * at the `package.json` pin (see `src/platform/adapters/dsh/event-bridge.ts`, which
 * does exactly this for the cordis `Events` augmentation). The RUNTIME rule
 * still holds: this adapter consumes the host structurally (ctx / service
 * surface) and MUST NOT gain a runtime (value) import of any host package.
 * Following the Pi adapter precedent
 * (`src/platform/adapters/pi/tool-factory.ts` uses loose typing for its
 * optional peer dependency), this adapter emits structurally-compatible plain
 * objects and defines local structural types mirroring the documented DSL.
 * The returned object is opaque per `IToolFactory` ("only the platform
 * runtime interprets it"); the dsh plugin layer registers it directly with
 * `ctx.tools.register(compiled)`.
 *
 * MUST NOT value-import any package from the opencode platform SDK or the
 * deepseek dsh-tools SDK — the host surface is consumed structurally, and a
 * runtime (value) dependency on a host package is the line never crossed.
 */

import { z } from "zod";
import type { IToolFactory } from "../../ports/tool-factory.ts";
import type { DshContentBlock } from "./agent-registrar.ts";
import type {
  CanonicalToolDef,
  CanonicalToolContext,
  ToolResult,
} from "../../types.ts";

// ── Structural dsh-tools types (loose mirrors of the verified DSL) ─────────

/** Annotation keywords shared by every author-facing value-schema node
 * (dsh-tools schema.d.ts:11-19). Non-validating. */
export interface DshValueSchemaAnnotations {
  description?: string;
  title?: string;
  default?: unknown;
  examples?: unknown;
}

/**
 * Author-facing value-schema DSL — a discriminated union mirroring the real
 * `ValueSchemaSpec` (dsh-tools schema.d.ts:20-72). Modelled as a union rather
 * than a flat bag of optional fields so the `object` variant's
 * `additionalProperties` is REQUIRED exactly as the harness declares it
 * (schema.d.ts:56-61) — a flat optional field let an object node omit the
 * openness that rc.6 mandates.
 */
export interface DshStringValueSchema extends DshValueSchemaAnnotations {
  type: "string";
  enum?: readonly string[];
  const?: string;
}
export interface DshNumberValueSchema extends DshValueSchemaAnnotations {
  type: "number";
  enum?: readonly number[];
  const?: number;
}
export interface DshIntegerValueSchema extends DshValueSchemaAnnotations {
  type: "integer";
  enum?: readonly number[];
  const?: number;
}
export interface DshBooleanValueSchema extends DshValueSchemaAnnotations {
  type: "boolean";
  enum?: readonly boolean[];
  const?: boolean;
}
export interface DshNullValueSchema extends DshValueSchemaAnnotations {
  type: "null";
  enum?: readonly null[];
  const?: null;
}
export interface DshArrayValueSchema extends DshValueSchemaAnnotations {
  type: "array";
  /** Item schema; absent accepts any JSON item. */
  items?: DshValueSchemaSpec;
}
export interface DshObjectValueSchema extends DshValueSchemaAnnotations {
  type: "object";
  /** Per-property schema. */
  properties?: DshParameterSchemaSpec;
  /** Object openness (`false` rejects undeclared keys) — REQUIRED (rc.6). */
  additionalProperties: boolean;
}
export interface DshJsonValueSchema extends DshValueSchemaAnnotations {
  type: "json";
}
export interface DshOneOfValueSchema extends DshValueSchemaAnnotations {
  /** Exact-one union; ≥2 branches. */
  oneOf: readonly DshValueSchemaSpec[];
}
/** One author-facing value-schema node for any lossless JSON value root. */
export type DshValueSchemaSpec =
  | DshStringValueSchema
  | DshNumberValueSchema
  | DshIntegerValueSchema
  | DshBooleanValueSchema
  | DshNullValueSchema
  | DshArrayValueSchema
  | DshObjectValueSchema
  | DshJsonValueSchema
  | DshOneOfValueSchema;

/**
 * One implicit parameter-root property: a value spec plus per-property
 * requiredness (dsh-tools schema.d.ts:74-76). Requiredness is NEVER a
 * top-level `required` array in the DSL.
 */
export type DshParameterPropertySpec = DshValueSchemaSpec & { required?: true };

/**
 * Tool parameter schema — an implicit open object root keyed by property
 * name (dsh-tools schema.d.ts:81-84). This is the INTERNAL author DSL the
 * zod mapper produces; it is NOT what `register()` consumes. Compile it to
 * `DshJsonSchema` with `dslParameterMapToJsonSchema()` first.
 */
export type DshParameterSchemaSpec = {
  [key: string]: DshParameterPropertySpec;
};

/**
 * Standard JSON Schema (the enforced raw subset, dsh-tools contract §3.3).
 * This is what `register()` stores, the LLM wire serializes, and Code Mode's
 * SDK renderers read. Annotation-only `{}` is the unconstrained-JSON form.
 */
export interface DshJsonSchema {
  type?: "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";
  /** Property schemas for `type: "object"`. */
  properties?: Record<string, DshJsonSchema>;
  /** REQUIRED top-level array (never per-property) — lifted from the DSL. */
  required?: string[];
  /** Object openness for `type: "object"`. */
  additionalProperties?: boolean;
  /** Item schema for `type: "array"`; absent accepts any JSON item. */
  items?: DshJsonSchema;
  /** Exact-one union; ≥2 branches. */
  oneOf?: DshJsonSchema[];
  /** Allowed scalar values. */
  enum?: Array<string | number | boolean | null>;
  /** Single allowed scalar value. */
  const?: string | number | boolean | null;
  /** Annotation keywords (non-validating). */
  description?: string;
  title?: string;
  default?: unknown;
  examples?: unknown;
}

/**
 * Loose mirror of `ToolRunContext` — the second argument of `defineTool`'s
 * `execute`. Only the fields this adapter reads are typed; the dsh host
 * supplies the real object at runtime. rc.6 declares `callId`,
 * `deferContext`, and `concludeTurn` REQUIRED on the real `ToolRunContext`
 * (`dsh-tools/lib/types/index.d.ts:197,290,299`), so they are required here.
 */
export interface DshToolRunContext {
  /** REQUIRED caller-owned cancellation (contract §3.5). */
  signal: AbortSignal;
  /** REQUIRED provider-issued call id (`index.d.ts:197`). */
  callId: string;
  rootCallId?: string;
  /** The agent on whose behalf the call runs (scope routing key). */
  agent?: {
    id?: string;
    session?: { id?: string; header?: { cwd?: string } };
  };
  /** REQUIRED — defer context onto this call's result (`index.d.ts:290`). */
  deferContext(context: unknown): void;
  /** REQUIRED — mark the result terminal for the agent turn (`index.d.ts:299`). */
  concludeTurn(): void;
}

// ── Structural dsh presentation types (loose mirrors of presentation.ts) ────

/**
 * Loose mirror of the dsh `ToolCallKind` vocabulary
 * (`packages/core/tools/src/presentation.ts:15`) — the icon/treatment category
 * a pure `presentCall` projection may declare. `other` is the client default.
 */
export type DshToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "other";

/**
 * Loose mirror of the dsh `GenericCallView` (`presentation.ts:53-75`): the
 * default pending-call card. Only the fields rolebox projects are modelled; the
 * dsh host owns the full `ToolCallView` union (`generic | terminal | diff`) and
 * a UI bridge switches on `card`.
 */
export interface DshGenericCallView {
  card: "generic";
  /** Always-visible short label describing THIS call. */
  title: string;
  /** Icon/treatment category (client default: `other`). */
  kind?: DshToolCallKind;
  /** Salient input for a detail view (not the full raw args object). */
  rawInput?: unknown;
  /** Follow-along file locations (a read's path + optional 1-based line). */
  locations?: Array<{ path: string; line?: number }>;
}
/** The pending-call render intent a tool may declare (generic arm only). */
export type DshToolCallView = DshGenericCallView;

/**
 * Loose mirror of the dsh `GenericResultView` (`presentation.ts:146-155`): the
 * completed-state card. Omitted fields keep the pending title and render the
 * raw result content.
 */
export interface DshGenericResultView {
  card: "generic";
  /** Replacement title for the completed call. */
  title?: string;
  /** UI-facing result content (harness ContentBlocks). */
  content?: DshContentBlock[];
}
/** The completed-state render intent a tool may declare (generic arm only). */
export type DshToolResultView = DshGenericResultView;

/**
 * The completed outcome handed to `presentResult` — the subset of the dsh
 * `ToolResult` (`index.ts:283-295`) rolebox reads: whether the call failed and
 * the durable `meta` payload projected by `output.presentationMeta`.
 */
export interface DshPresentResult {
  /** The final model-facing content (or the rendered error text on failure). */
  content: DshContentBlock[];
  /** Whether the call failed. */
  isError: boolean;
  /** The tool-private presentation payload projected by `output.presentationMeta`. */
  meta?: unknown;
}

/**
 * The register-ready definition: what `ctx.tools.register()` stores — the
 * structural mirror of the harness `ToolDefinition` register input
 * (`dsh-tools/lib/types/index.d.ts:106-124`), NOT `defineTool()` options.
 * `parameters` is already standard JSON Schema (`DshJsonSchema`) because
 * `register()` does NOT compile it, and `output.schema` is raw JSON Schema
 * (`DshJsonSchema`) for the same reason. The dsh plugin layer calls
 * `ctx.tools.register(compiled)` directly.
 *
 * The presentation/execution members (`presentCall`, `presentResult`,
 * `output.presentationMeta`, `timeoutMs`, `isConcurrencySafe`) are all OPTIONAL
 * and are emitted only for tools where rolebox has truthful data — see
 * `DSH_TOOL_PRESENTATION`. Their absence is the honest dsh generic fallback,
 * never a placeholder.
 */
export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: DshJsonSchema;
  output: {
    schema: DshJsonSchema;
    render(args: unknown, value: unknown): DshContentBlock[];
    /**
     * Pure, replay-safe projection of the canonical ToolResult's own display
     * metadata into the durable `tool/result` `meta` payload
     * (`index.ts:210`). Computed only for top-level calls and MUST depend only
     * on `args` + `value`, so a session-log replay reconstructs identical meta.
     * Omitted when rolebox has no truthful display metadata for the tool.
     */
    presentationMeta?(args: unknown, value: unknown): unknown;
  };
  /**
   * Cooperative tool-call timeout budget in milliseconds (`index.ts:247`).
   * Omitted for every rolebox tool: the canonical contract carries no fixed,
   * tool-wide deadline, and the tools' per-call timeout arguments are not a
   * fixed cooperative budget — declaring one would kill legitimate long calls.
   */
  timeoutMs?: number;
  /**
   * Pure synchronous classifier for overlap with sibling calls (`index.ts:261`).
   * Declared only for rolebox tools whose body provably reads and mutates no
   * parent-owned state (see `DSH_TOOL_PRESENTATION`); omitted elsewhere.
   */
  isConcurrencySafe?(args: unknown): boolean;
  /**
   * Pending-state render intent, derived from `args` alone (`index.ts:271`).
   * Pure and side-effect-free — dsh may call it during live streaming AND a
   * session-log replay. Omitted when rolebox has no truthful call view.
   */
  presentCall?(args: unknown): DshToolCallView | undefined;
  /**
   * Completed-state render intent, from `args` and the durable result
   * (`index.ts:279`). Pure and side-effect-free for the same replay reason.
   * Omitted when rolebox has no truthful result view.
   */
  presentResult?(args: unknown, result: DshPresentResult): DshToolResultView | undefined;
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
  const ann: DshValueSchemaAnnotations = {};
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
      return isInt ? { ...ann, type: "integer" } : { ...ann, type: "number" };
    }
    case "boolean":
      return { ...ann, type: "boolean" };
    case "null":
      return { ...ann, type: "null" };
    case "literal": {
      const v = def.values?.[0];
      if (typeof v === "string") return { ...ann, type: "string", const: v };
      if (typeof v === "number")
        return Number.isInteger(v)
          ? { ...ann, type: "integer", const: v }
          : { ...ann, type: "number", const: v };
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

// ── Author DSL → register-ready raw JSON Schema ──────────────────────────────

/**
 * Compile one author-DSL value node to raw JSON Schema, mirroring
 * `defineTool()`'s internal compiler (dsh-tools lib/index.js:769-793). The
 * author `json` node (and any untyped node) becomes the annotation-only `{}`.
 */
function dslValueToJsonSchema(node: DshValueSchemaSpec): DshJsonSchema {
  const ann = jsonAnnotations(node);

  if ("oneOf" in node) {
    return { ...ann, oneOf: node.oneOf.map((branch) => dslValueToJsonSchema(branch)) };
  }

  switch (node.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null": {
      const out: DshJsonSchema = { ...ann, type: node.type };
      if (node.enum !== undefined) out.enum = [...node.enum];
      if (node.const !== undefined) out.const = node.const;
      return out;
    }
    case "array": {
      const out: DshJsonSchema = { ...ann, type: "array" };
      if (node.items !== undefined) out.items = dslValueToJsonSchema(node.items);
      return out;
    }
    case "object":
      return dslObjectToJsonSchema(node, ann);
    case "json":
    default:
      return ann;
  }
}

/** Copy the annotation keywords shared by every raw value node. */
function jsonAnnotations(node: DshValueSchemaSpec): DshJsonSchema {
  const out: DshJsonSchema = {};
  if (node.description !== undefined) out.description = node.description;
  if (node.title !== undefined) out.title = node.title;
  if (node.default !== undefined) out.default = node.default;
  if (node.examples !== undefined) out.examples = node.examples;
  return out;
}

/**
 * Compile one author-DSL property map (object `properties` or the implicit
 * parameter root) to raw `{ properties, required }`, lifting per-property
 * `required: true` into the top-level array (dsh-tools lib/index.js:600-646).
 */
function dslPropertiesToRaw(spec: DshParameterSchemaSpec): {
  properties: Record<string, DshJsonSchema>;
  required: string[];
} {
  const properties: Record<string, DshJsonSchema> = {};
  const required: string[] = [];
  for (const [key, prop] of Object.entries(spec)) {
    const { required: req, ...valueNode } = prop;
    properties[key] = dslValueToJsonSchema(valueNode as DshValueSchemaSpec);
    if (req === true) required.push(key);
  }
  return { properties, required };
}

/** Compile an author-DSL `object` node to raw JSON Schema. */
function dslObjectToJsonSchema(node: DshObjectValueSchema, ann: DshJsonSchema): DshJsonSchema {
  const out: DshJsonSchema = {
    ...ann,
    type: "object",
    additionalProperties: node.additionalProperties,
  };
  if (node.properties !== undefined) {
    const { properties, required } = dslPropertiesToRaw(node.properties);
    out.properties = properties;
    if (required.length > 0) out.required = required;
  }
  return out;
}

/**
 * Compile the implicit parameter root (a per-property author-DSL map) to the
 * object-rooted raw JSON Schema `register()` stores.
 */
export function dslParameterMapToJsonSchema(spec: DshParameterSchemaSpec): DshJsonSchema {
  const { properties, required } = dslPropertiesToRaw(spec);
  const out: DshJsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;
  return out;
}

// ── Canonical value / context mapping ────────────────────────────────────────

/**
 * Render a canonical ToolResult (string | {output, metadata, ...}) as native
 * text content. String results pass through; object results prefer `output`
 * and fall back to a JSON projection.
 */
function toTextContent(value: unknown): DshContentBlock[] {
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

// ── Incoming args validation ─────────────────────────────────────────────────

/**
 * Whether the value addressed by a zod issue path is ABSENT from the raw
 * incoming args (as opposed to present-but-invalid). Walks the path so a
 * missing nested property is also recognized. An explicit `undefined` at the
 * leaf counts as absent, matching zod's own missing-value semantics.
 */
function isAbsentAtPath(input: unknown, path: readonly PropertyKey[]): boolean {
  let cursor: unknown = input;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return true;
    const record = cursor as Record<PropertyKey, unknown>;
    if (!(segment in record)) return true;
    cursor = record[segment];
  }
  return cursor === undefined;
}

/**
 * Render a zod validation failure as a model-facing correction STRING in the
 * dsh host's native style, e.g.
 *   invalid arguments: missing required property "objective"
 *   invalid arguments: "text" must be a string
 *
 * Returning this instead of throwing lets the model self-correct within the
 * same turn (a thrown TypeError surfaced as an opaque tool error).
 */
function formatArgCorrection(issues: readonly z.core.$ZodIssue[], input: unknown): string {
  const clauses: string[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) clauses.push(`unrecognized property "${key}"`);
      continue;
    }
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    if (isAbsentAtPath(input, issue.path)) {
      clauses.push(`missing required property "${path}"`);
      continue;
    }
    if (issue.code === "invalid_type") {
      clauses.push(`"${path}" must be a ${issue.expected}`);
      continue;
    }
    clauses.push(`"${path}" ${issue.message}`);
  }
  return `invalid arguments: ${clauses.join("; ")}`;
}

// ── Reserved tool names ──────────────────────────────────────────────────────

/**
 * The tool name dsh reserves unconditionally for its PTC (programmatic tool
 * calling) / code-mode presentation transport — dsh `RUN_CODE_NAME`
 * (`packages/core/tools/src/ptc.ts:20`, 0.1.5-rc.1). A rolebox tool can never
 * take this name: `ctx.tools.register()` throws on the collision.
 */
export const DSH_RESERVED_RUN_CODE_NAME = "run_code";

/**
 * Thrown by {@link DshToolFactory} at compile time when a tool would take the
 * dsh harness-reserved name `run_code`. dsh reserves it unconditionally for the
 * PTC / code-mode presentation transport and `ctx.tools.register()` throws on
 * the collision (dsh 0.1.5-rc.1 `packages/core/tools/src/index.ts:1044-1046`),
 * so registration cannot succeed. The factory refuses BEFORE registration with
 * this clear, named error instead of letting the host throw a bare `Error`
 * mid-registration.
 */
export class DshReservedToolNameError extends Error {
  /** The colliding tool name (the reserved transport name). */
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `dsh reserves the tool name "${toolName}" for its PTC/code-mode presentation transport; ` +
        `rolebox cannot compile or register a tool under it — ctx.tools.register() rejects the ` +
        `reserved name (dsh packages/core/tools/src/index.ts:1044-1046). Rename the rolebox tool.`,
    );
    this.name = "DshReservedToolNameError";
    this.toolName = toolName;
  }
}

// ── Native presentation projections ─────────────────────────────────────────
//
// dsh's optional presentation surface lets a tool declare how a call renders in
// a UI without the client special-casing tool names (dsh
// `packages/core/tools/src/presentation.ts`). Every projection here is PURE and
// replay-safe — dsh may invoke a presenter during live streaming AND when
// replaying a session log (`index.ts:265-279`), so each depends only on its
// arguments and mutates nothing.
//
// Honesty rule: an optional member is emitted ONLY where rolebox has truthful
// data. Absent members are dsh's own generic fallback (title = tool name, raw
// args), which is strictly better than a fabricated placeholder.
//
// `timeoutMs` is deliberately absent from every entry: rolebox's canonical tool
// contract carries no fixed, tool-wide deadline, and the tools' per-call timeout
// arguments (e.g. `web_fetch.timeout`, `interactive_terminal.timeout_ms`) are
// not a fixed cooperative budget — advertising one would abort legitimate long
// calls. `isConcurrencySafe` is declared ONLY where the tool body provably reads
// and mutates no parent-owned state.

/** Pure projection of a canonical ToolResult's own display metadata. */
function displayMetaFromValue(
  value: unknown,
): { title?: string; metadata?: Record<string, unknown> } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as { title?: unknown; metadata?: unknown };
  const out: { title?: string; metadata?: Record<string, unknown> } = {};
  if (typeof v.title === "string" && v.title.length > 0) out.title = v.title;
  if (
    v.metadata !== null &&
    typeof v.metadata === "object" &&
    !Array.isArray(v.metadata) &&
    Object.keys(v.metadata).length > 0
  ) {
    out.metadata = v.metadata as Record<string, unknown>;
  }
  return out.title !== undefined || out.metadata !== undefined ? out : undefined;
}

/** Pure narrowing of the durable presentation meta into a generic result card. */
function genericResultFromMeta(meta: unknown): DshToolResultView | undefined {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const title = (meta as { title?: unknown }).title;
  return typeof title === "string" && title.length > 0 ? { card: "generic", title } : undefined;
}

/** Pure `presentCall` for a file read (`Read <path>` + follow-along location). */
function presentReadCall(args: unknown): DshToolCallView | undefined {
  const a = args as { filePath?: unknown; offset?: unknown; limit?: unknown };
  if (typeof a.filePath !== "string" || a.filePath.length === 0) return undefined;
  const offset = typeof a.offset === "number" ? a.offset : undefined;
  const limit = typeof a.limit === "number" ? a.limit : undefined;
  const window =
    limit !== undefined && limit > 0
      ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
      : offset !== undefined
        ? ` (from line ${offset})`
        : "";
  return {
    card: "generic",
    title: `Read ${a.filePath}${window}`,
    kind: "read",
    locations: [{ path: a.filePath, line: offset ?? 1 }],
  };
}

/** Pure `presentCall` for a query-shaped search tool. */
function presentSearchCall(args: unknown): DshToolCallView | undefined {
  const query = (args as { query?: unknown }).query;
  if (typeof query !== "string" || query.length === 0) return undefined;
  return { card: "generic", title: query, kind: "search", rawInput: query };
}

/** Pure `presentCall` for a URL-shaped fetch/read tool. */
function presentFetchCall(args: unknown): DshToolCallView | undefined {
  const url = (args as { url?: unknown }).url;
  if (typeof url !== "string" || url.length === 0) return undefined;
  return { card: "generic", title: url, kind: "fetch", rawInput: url };
}

/** Pure `presentCall` for the interactive-terminal action tool. */
function presentTerminalCall(args: unknown): DshToolCallView | undefined {
  const a = args as { action?: unknown; id?: unknown; command?: unknown };
  const action = typeof a.action === "string" && a.action.length > 0 ? a.action : "call";
  const id = typeof a.id === "string" && a.id.length > 0 ? a.id : undefined;
  const command =
    typeof a.command === "string" && a.command.length > 0 ? a.command : undefined;
  const title =
    action === "open"
      ? `Terminal: ${command ?? "$SHELL"}`
      : `Terminal ${action}${id !== undefined ? ` ${id}` : ""}`;
  const rawInput = action === "open" ? command : id;
  return rawInput !== undefined
    ? { card: "generic", title, kind: "execute", rawInput }
    : { card: "generic", title, kind: "execute" };
}

/** One tool's optional native-presentation / execution-classifier surface. */
export interface DshToolPresentation {
  presentCall?(args: unknown): DshToolCallView | undefined;
  presentationMeta?(args: unknown, value: unknown): unknown;
  presentResult?(args: unknown, result: DshPresentResult): DshToolResultView | undefined;
  isConcurrencySafe?(args: unknown): boolean;
}

/**
 * The rolebox tools that render natively in the dsh client. Exported so tests
 * and the contract drift detector can assert the surface. Tools absent here
 * fall back to dsh's generic presentation — the honest fallback when rolebox
 * has no truthful view to declare.
 */
export const DSH_TOOL_PRESENTATION: Readonly<Record<string, DshToolPresentation>> = {
  // File read: a `read` generic card (dsh analogue:
  // fs/tool-fs/src/read.ts `presentCall`). The body only reads the file and
  // formats it, so it may join a parallel group.
  hashline_read: { presentCall: presentReadCall, isConcurrencySafe: () => true },
  // Discovery tools: a `search` / `fetch` generic card derived from real args.
  web_search: { presentCall: presentSearchCall, isConcurrencySafe: () => true },
  web_read: { presentCall: presentFetchCall, isConcurrencySafe: () => true },
  asset_search: { presentCall: presentSearchCall, isConcurrencySafe: () => true },
  reference_search: { presentCall: presentSearchCall, isConcurrencySafe: () => true },
  // These two already attach their own display metadata (`title`/`metadata`) to
  // the canonical ToolResult, so their result projections mirror it faithfully
  // (dsh analogue: web/tool-web/src/fetch.ts). Their pending card is generic.
  web_fetch: {
    presentCall: presentFetchCall,
    presentationMeta: (_args, value) => displayMetaFromValue(value),
    presentResult: (_args, result) => genericResultFromMeta(result.meta),
    isConcurrencySafe: () => true,
  },
  interactive_terminal: {
    presentCall: presentTerminalCall,
    presentationMeta: (_args, value) => displayMetaFromValue(value),
    presentResult: (_args, result) => genericResultFromMeta(result.meta),
  },
  // Pure local reads over the resolved role set — no parent-owned state is
  // mutated, so overlap is safe even though they carry no custom card.
  asset_inspect: { isConcurrencySafe: () => true },
  asset_validate: { isConcurrencySafe: () => true },
};

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * IToolFactory adapter for the dsh platform.
 *
 * Compiles CanonicalToolDefs into register-ready definitions
 * (`DshToolDefinition`, the structural mirror of the harness `ToolDefinition`
 * register input — NOT `defineTool()` options): zod args → standard JSON
 * Schema `parameters`, the raw annotation-only `{}` for `output.schema`, a
 * text render, and an execute that maps `exec.signal` → `context.abort` and
 * returns the canonical ToolResult.
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
  ): DshToolDefinition {
    // Registration-time guard: dsh reserves `run_code` unconditionally for its
    // PTC/code-mode transport and register() throws on the collision (dsh
    // packages/core/tools/src/index.ts:1044-1046). Refuse before registration
    // with a named rolebox error rather than letting the host throw a bare
    // Error mid-registration.
    if (name === DSH_RESERVED_RUN_CODE_NAME) {
      throw new DshReservedToolNameError(name);
    }
    // Compile the author DSL to register-ready raw JSON Schema — register()
    // does not run defineTool()'s parameter compiler, so we must. See the
    // module header and dslParameterMapToJsonSchema().
    const parameters = dslParameterMapToJsonSchema(zodShapeToDsh(def.args));
    // Compiled once per tool (not per call) — the SAME zod object root drives
    // incoming-args validation in execute().
    const argsSchema = z.object(def.args);
    // Optional native-presentation surface. Absent for tools rolebox has no
    // truthful view for — they fall back to dsh's generic presentation. Members
    // are spread individually so an entry declaring only some of them never
    // emits the others as `undefined` placeholders.
    const presentation = DSH_TOOL_PRESENTATION[name];

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
        ...(presentation?.presentationMeta
          ? { presentationMeta: presentation.presentationMeta }
          : {}),
      },
      ...(presentation?.isConcurrencySafe
        ? { isConcurrencySafe: presentation.isConcurrencySafe }
        : {}),
      ...(presentation?.presentCall ? { presentCall: presentation.presentCall } : {}),
      ...(presentation?.presentResult
        ? { presentResult: presentation.presentResult }
        : {}),
      async execute(args, exec) {
        // Honor exec.signal: surface caller cancellation before invoking the
        // canonical body and forward the signal as context.abort.
        if (exec.signal?.aborted) {
          throw exec.signal.reason ?? new Error("tool call aborted");
        }
        // Validate the raw incoming args against the compiled zod root: the
        // dsh host does NOT parse `parameters` (they are raw JSON Schema for
        // the wire), so without this every canonical tool ran with required
        // args unenforced, `.default()` values unapplied, and `.min()`/.enum()
        // unrun — a missing required arg surfaced as a raw TypeError. On
        // failure return a correction STRING (host-native style) instead of
        // throwing. NON-strict parse: unknown keys are stripped, NOT rejected.
        // This deliberately diverges from the Pi path (src/hooks/tool-before.ts:104
        // uses `.strict()`) to keep the blast radius minimal — dsh callers may
        // pass extra keys, and rejecting them would turn valid calls into new
        // failures. `parsed.data` carries applied defaults and coerced types.
        const parsed = argsSchema.safeParse(args);
        if (!parsed.success) {
          return formatArgCorrection(parsed.error.issues, args);
        }
        const context = toCanonicalContext(exec);
        const result = await def.execute(parsed.data as never, context);
        // Canonical tools whose body returns a JSON-object string (e.g. the
        // graph tools' `json(...)`) must stay byte-identical as MODEL-VISIBLE
        // text (toTextContent prefers `.output`) while ALSO resolving to a
        // structured value for Code Mode callers (`created.graph_id`). When
        // the string parses to a plain non-array object with no own `output`
        // key, wrap it as `{ output: <original string>, ...parsed }` — the
        // spread cannot clobber `output` because we checked the key is absent,
        // so rendered text is unchanged. Every other shape (non-JSON string,
        // array, scalar, or an object already carrying `output`) passes
        // through unchanged. Confined to the dsh adapter: src/graph/tools/
        // index.ts `json()` is untouched because opencode/Pi render it as text.
        if (typeof result === "string") {
          try {
            const parsed = JSON.parse(result) as unknown;
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              !Object.prototype.hasOwnProperty.call(parsed, "output")
            ) {
              return { output: result, ...(parsed as Record<string, unknown>) };
            }
          } catch {
            // Not JSON — pass the original string through unchanged.
          }
        }
        return result; // canonical ToolResult — lossless JSON
      },
    };
  }
}

// ── Compile-time contract guard ──────────────────────────────────────
// Erased at emit. `bun run typecheck` fails if any rc.6-required member is
// loosened to optional: the conditional resolves to `false`, which violates
// `_AllRequired`'s `readonly true[]` constraint. Mirrors the test-only
// assertion in tests/platform/dsh-tool-factory.test.ts (tests are not part of
// the `tsc` include, so the guard lives here to actually gate the build).
type _IsRequired<T, K extends keyof T> = undefined extends T[K] ? false : true;
type _AllRequired<T extends readonly true[]> = T;
type _DshToolRunContextRequiredGuard = _AllRequired<
  [
    _IsRequired<DshToolRunContext, "callId">,
    _IsRequired<DshToolRunContext, "deferContext">,
    _IsRequired<DshToolRunContext, "concludeTurn">,
  ]
>;
