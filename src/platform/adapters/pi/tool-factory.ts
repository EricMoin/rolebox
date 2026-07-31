/**
 * Pi tool factory adapter — implements IToolFactory by compiling
 * canonical tool definitions into Pi's native tool format.
 *
 * Pi's registerTool format (from its ExtensionAPI):
 *   pi.registerTool({
 *     name, label, description,
 *     parameters: TypeBox schema (JSON Schema compatible),
 *     execute(toolCallId, params, signal, onUpdate, ctx) { ... }
 *   })
 *
 * Since @earendil-works/pi-coding-agent is an optional peer dependency,
 * this adapter uses loose typing (no direct import from Pi).
 */

import { z, toJSONSchema } from "zod";
import type { IToolFactory } from "../../ports/tool-factory.ts";
import type { CanonicalToolDef, CanonicalToolContext, ToolResult } from "../../types.ts";
import { interceptToolBefore } from "./tool-interceptor.ts";
import type { ToolInterceptorHooks } from "./tool-interceptor.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a kebab-case, snake_case, or camelCase name to Title Case for the label.
 */
function toLabel(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Convert a ZodRawShape to a JSON Schema object using zod's built-in
 * toJSONSchema utility. Wraps the shape in a ZodObject first so that
 * zod generates a complete object-level JSON Schema with `properties`,
 * `required`, and per-field schemas (including defaults, descriptions,
 * enums, min/max constraints, etc.).
 */
function zodShapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const obj = z.object(shape);
  return toJSONSchema(obj) as Record<string, unknown>;
}

/**
 * Map a canonical ToolResult to Pi's { content, details } format.
 * Canonical results can be either a plain string or a structured object
 * with output, metadata, and attachments.
 */
function toPiResult(
  result: ToolResult,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], details: {} };
  }
  return {
    content: [{ type: "text", text: result.output }],
    details: result.metadata ?? {},
  };
}

/**
 * Construct a CanonicalToolContext from Pi's tool execute parameters.
 *
 * Pi passes these parameters to every tool execute callback:
 *   - toolCallId: unique identifier for this invocation
 *   - signal: AbortSignal for cancellation
 *   - onUpdate: progress-reporting callback
 *   - ctx: platform context object (session, directory, utility methods)
 *
 * Since Pi's context shape is not imported (optional peer dep), we extract
 * fields by convention and provide sensible fallbacks.
 */
function toCanonicalContext(
  toolCallId: string,
  signal: AbortSignal,
  _onUpdate: (msg: string) => void,
  ctx: Record<string, unknown>,
): CanonicalToolContext {
  const c = ctx as Record<string, unknown>;

  return {
    sessionID: String(c.sessionID ?? c.session_id ?? c.sessionId ?? toolCallId),
    messageID: String(c.messageID ?? c.message_id ?? c.messageId ?? toolCallId),
    agent: String(c.agent ?? c.agentName ?? c.agent_name ?? ""),
    directory: String(c.directory ?? c.dir ?? c.cwd ?? ""),
    worktree: String(c.worktree ?? c.workTree ?? c.workspace ?? c.root ?? ""),
    abort: signal,
    metadata(input) {
      const fn = c.metadata as unknown;
      if (typeof fn === "function") {
        (fn as (input: { title?: string; metadata?: Record<string, unknown> }) => void)(input);
      }
    },
    async ask(input) {
      const fn = c.ask as unknown;
      if (typeof fn === "function") {
        await (
          fn as (
            input: {
              permission: string;
              patterns: string[];
              always: string[];
              metadata: Record<string, unknown>;
            },
          ) => Promise<void>
        )(input);
      }
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * IToolFactory adapter for the Pi platform.
 *
 * Compiles CanonicalToolDefs into Pi-compatible tool definition objects
 * that can be passed to pi.registerTool().
 *
 * Prefer compileAll() over compile() because Pi tool definitions require
 * a name (the record key), which is only available in compileAll().
 */
export class PiToolFactory implements IToolFactory {
  /** Optional hook wiring for the tool-execution interceptor (subtask S9). */
  #hooks: ToolInterceptorHooks | undefined;

  constructor(hooks?: ToolInterceptorHooks) {
    this.#hooks = hooks;
  }

  compile<Args extends z.ZodRawShape>(def: CanonicalToolDef<Args>): unknown {
    // compile() does not receive a tool name, which Pi requires for
    // registration. Use compileAll() when names are available, or
    // patch the name on the returned object.
    return this.#compileNamed("", def);
  }

  /**
   * Internal helper — compile a single CanonicalToolDef with an explicit name.
   */
  #compileNamed<Args extends z.ZodRawShape>(
    name: string,
    def: CanonicalToolDef<Args>,
  ): Record<string, unknown> {
    const jsonSchema = zodShapeToJsonSchema(def.args);
    // Capture the interceptor wiring — the returned execute closure runs in
    // the context of the tool object, not the factory, so `this` is unsafe.
    const hooks = this.#hooks;

    return {
      name,
      label: name ? toLabel(name) : "",
      description: def.description,
      parameters: jsonSchema,
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (msg: string) => void,
        ctx: Record<string, unknown>,
      ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
        const context = toCanonicalContext(toolCallId, signal, onUpdate, ctx);
        // Subtask S9 — tool-execution interceptor: run the shared
        // handleToolBefore pipeline (strict zod validation, deprecated
        // warnings, custom-hook before/after phases, correction injection)
        // BEFORE invoking the canonical def. Validation failures return an
        // error string listing valid parameters instead of throwing into Pi.
        const check = await interceptToolBefore(
          name,
          toolCallId,
          (params ?? {}) as Record<string, unknown>,
          context,
          hooks,
        );
        if (!check.ok) return toPiResult(check.error);
        // Params arrive as Record<string, unknown> from Pi's runtime.
        // The schema guarantees shape compatibility — cast through unknown.
        const result = await def.execute(check.args as any, context);
        return toPiResult(result);
      },
    };
  }

  /**
   * Compile a record of named canonical tool definitions into a record of
   * Pi-compatible tool objects. The record key becomes the tool's `name`
   * and drives the auto-generated `label`.
   */
  compileAll(defs: Record<string, CanonicalToolDef>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      result[name] = this.#compileNamed(name, def);
    }
    return result;
  }
}
