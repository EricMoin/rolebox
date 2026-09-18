/**
 * Codex MCP tool factory — compiles canonical tool definitions into the
 * descriptors and call results the MCP `tools/list` / `tools/call` surface
 * needs.
 *
 * Codex's MCP client never sees a rolebox-native tool object: it receives a
 * `{ name, description, inputSchema }` descriptor per tool and sends back
 * `arguments` for one call. This adapter owns that translation, including the
 * zod argument validation and the correction-text convention (a failed call is
 * an `isError` RESULT the model can self-correct from — never a thrown error
 * and never a protocol error).
 *
 * @module
 */

import { z, toJSONSchema } from "zod";
import type { IToolFactory } from "../../ports/tool-factory.ts";
import type { CanonicalToolDef, CanonicalToolContext, ToolResult } from "../../types.ts";
import { formatError } from "../../../logger.ts";

// ── Wire shapes ──────────────────────────────────────────────────────────────

/** One entry of an MCP `tools/list` response. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One MCP `tools/call` result — text content plus an optional isError flag. */
export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Deprecation notice appended to the model-facing description. */
function withDeprecation(
  description: string,
  deprecated: CanonicalToolDef["deprecated"],
): string {
  if (!deprecated) return description;
  if (deprecated === true) return `${description}\n\n[DEPRECATED]`;
  return `${description}\n\n[DEPRECATED] ${deprecated.message}`;
}

/**
 * Convert a ZodRawShape to a JSON Schema object using zod's built-in
 * `toJSONSchema` utility, in `io: "input"` mode so defaults and coercions are
 * described as the caller must send them. The top-level `type` is forced to
 * `"object"` (MCP requires an object schema for `inputSchema`).
 */
function zodShapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  return { ...schema, type: "object" };
}

/** Map a canonical ToolResult to an MCP result — metadata never rides the text. */
function toMcpResult(result: ToolResult): McpToolCallResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return { content: [{ type: "text", text: result.output }] };
}

/** An `isError` result carrying one text block. */
function errorResult(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
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
 * Render a zod validation failure as a model-facing correction STRING naming
 * the offending fields, e.g.
 *   invalid arguments: missing required property "text"
 *   invalid arguments: "offset" must be a number
 *
 * Mirrors the dsh adapter's correction style so the model self-corrects within
 * the same turn instead of seeing an opaque tool error.
 */
function formatArgCorrection(
  issues: readonly z.core.$ZodIssue[],
  input: unknown,
): string {
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

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * IToolFactory adapter for the Codex MCP surface.
 *
 * `compileAll` both records the canonical definitions (so `call` can resolve a
 * tool by the server-visible name) and returns the `tools/list` descriptors.
 * `compile` alone returns an UNNAMED descriptor — MCP tool names come from the
 * registration key, which `compile` does not receive (same documented
 * limitation as PiToolFactory.compile). Prefer `compileAll`.
 */
export class CodexMcpToolFactory implements IToolFactory {
  #defs = new Map<string, CanonicalToolDef>();

  constructor(defs?: Record<string, CanonicalToolDef>) {
    if (defs) this.compileAll(defs);
  }

  compile<Args extends z.ZodRawShape>(def: CanonicalToolDef<Args>): unknown {
    return this.#describe("", def);
  }

  /**
   * Compile a record of named canonical tool definitions into MCP descriptors,
   * recording each definition for {@link call}. The record key is the
   * server-visible tool name.
   */
  compileAll(defs: Record<string, CanonicalToolDef>): Record<string, McpToolDescriptor> {
    const descriptors: Record<string, McpToolDescriptor> = {};
    for (const [name, def] of Object.entries(defs)) {
      this.#defs.set(name, def);
      descriptors[name] = this.#describe(name, def);
    }
    return descriptors;
  }

  /**
   * Execute one `tools/call`.
   *
   * Returns an `isError` result — never throws — for an unknown tool name, a
   * zod validation failure (with a correction string naming the offending
   * fields), or a tool body that throws, so a bad call can never escape to the
   * protocol layer.
   */
  async call(
    name: string,
    args: unknown,
    context: CanonicalToolContext,
  ): Promise<McpToolCallResult> {
    const def = this.#defs.get(name);
    if (!def) {
      return errorResult(
        `unknown tool: "${name}". No tool with that name is registered on this server.`,
      );
    }

    const rawArgs = args ?? {};
    const parsed = z.object(def.args).safeParse(rawArgs);
    if (!parsed.success) {
      return errorResult(formatArgCorrection(parsed.error.issues, rawArgs));
    }

    try {
      const result = await def.execute(parsed.data as never, context);
      return toMcpResult(result);
    } catch (err) {
      return errorResult(`tool "${name}" failed: ${formatError(err).message}`);
    }
  }

  /** Build one descriptor; `name` is "" for the unnamed `compile` path. */
  #describe<Args extends z.ZodRawShape>(
    name: string,
    def: CanonicalToolDef<Args>,
  ): McpToolDescriptor {
    return {
      name,
      description: withDeprecation(def.description, def.deprecated),
      inputSchema: zodShapeToJsonSchema(def.args),
    };
  }
}
