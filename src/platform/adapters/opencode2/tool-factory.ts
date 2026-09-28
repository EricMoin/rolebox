/**
 * opencode v2 tool factory — implements IToolFactory by compiling canonical
 * tool definitions into the v2 `Tool.Info` shape the `@opencode/plugin`
 * promise API registers through `ctx.tool.transform(editor => editor.add(info))`.
 *
 * The compiled object is
 *   { name, description, input, execute(input, context) => Promise<Tool.Result> }
 * (node_modules/@opencode/plugin/dist/promise/tool.d.ts:13-15 wraps
 * `Tool.Info` from node_modules/@opencode/schema/dist/tool.d.ts:71-78, whose
 * `input` is a `Tool.ValueSchema` = Schema.Codec | StandardSchemaV1 |
 * JsonSchema, and whose `execute` receives `ToolContext` — the tool call's
 * session/agent/message ids, the call id, a `progress` reporter and the
 * abort `signal`).
 *
 * Names come from the record key in compileAll(), exactly as in the Pi, dsh
 * and codex adapters: a CanonicalToolDef carries no name, so compile() can
 * only emit a nameless tool.
 */

import { z } from "zod";
import type { IToolFactory } from "../../ports/tool-factory.ts";
import type { CanonicalToolContext, CanonicalToolDef, ToolResult } from "../../types.ts";
import type {
  Info as Opencode2ToolInfo,
  Result as Opencode2ToolResult,
  ToolContext as Opencode2ToolContext,
} from "@opencode/plugin/promise/tool";

/** The compiled v2 tool definition, as `ctx.tool.transform` receives it. */
export type Opencode2CompiledTool = Opencode2ToolInfo;

export interface Opencode2ToolFactoryOptions {
  /**
   * Working directory stamped onto every tool context — the entry passes
   * `ctx.location.directory` (node_modules/@opencode/plugin/dist/promise/plugin.d.ts:27).
   */
  directory: string;
  /**
   * Project root for `CanonicalToolContext.worktree`; defaults to `directory`.
   * v2's `ToolContext` carries neither (tool.d.ts:9-12), so both travel from
   * the plugin's location, not from the tool call.
   */
  worktree?: string;
}

/**
 * Map the v2 tool context onto CanonicalToolContext.
 *
 * `sessionID`/`agent`/`messageID`/`abort` are direct: v2's ToolContext has the
 * same ids plus `signal`. `metadata` is v2's `progress` reporter. `ask` has no
 * v2 counterpart at all — the v2 tool context exposes no permission request,
 * and the plugin permission domain is `Pick<PermissionApi, "list" | "get" |
 * "reply">` (node_modules/@opencode/plugin/dist/promise/permission.d.ts:19-21):
 * it can answer a permission request but cannot create one. `ask` therefore
 * resolves without prompting (DEGRADATION — same shape as the Pi adapter when
 * its host callback is absent, src/platform/adapters/pi/tool-factory.ts:120-140).
 */
function toCanonicalContext(
  context: Opencode2ToolContext,
  directory: string,
  worktree: string,
): CanonicalToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory,
    worktree,
    abort: context.signal,
    metadata(input) {
      // Canonical metadata() is synchronous fire-and-forget (void); v2's
      // progress() returns a promise, so the update is dispatched without
      // blocking the tool body. v2's Tool.Metadata is a flat record — the
      // canonical { title?, metadata? } object is passed through unchanged so
      // no key is renamed or dropped.
      void context.progress({ ...input });
    },
    async ask(_input) {
      // Documented no-op — see the function comment above.
    },
  };
}

/**
 * Map rolebox's ToolResult onto v2 `Tool.Result` without losing tool text.
 *
 * The text lands in `content` (which v2 types as `string | Content[]`), not in
 * `output`: `output` is the value of the tool's declared `output` schema
 * (node_modules/@opencode/schema/dist/tool.d.ts:66-70) and the compiled tools
 * declare none. `title` — display metadata in the canonical shape — is folded
 * into `metadata` alongside the tool's own metadata (the tool's own keys win),
 * and canonical attachments become v2 `file` content blocks.
 */
function toToolResult(result: ToolResult): Opencode2ToolResult {
  if (typeof result === "string") return { content: result };
  const attachments = result.attachments ?? [];
  const metadata = {
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.metadata ?? {}),
  };
  return {
    content:
      attachments.length === 0
        ? result.output
        : [
            { type: "text" as const, text: result.output },
            ...attachments.map((attachment) => ({
              type: "file" as const,
              uri: attachment.url,
              mime: attachment.mime,
              ...(attachment.filename !== undefined ? { name: attachment.filename } : {}),
            })),
          ],
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * IToolFactory adapter for opencode v2.
 *
 * Prefer compileAll() over compile(): a v2 Tool.Info requires a `name`, which
 * only the record key provides ("" marks "name unknown to the factory").
 */
export class Opencode2ToolFactory implements IToolFactory {
  readonly #directory: string;
  readonly #worktree: string;

  constructor(options: Opencode2ToolFactoryOptions) {
    this.#directory = options.directory;
    this.#worktree = options.worktree ?? options.directory;
  }

  compile<Args extends z.ZodRawShape>(def: CanonicalToolDef<Args>): unknown {
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
  ): Opencode2CompiledTool {
    // zod v4 objects implement StandardSchemaV1, which Tool.ValueSchema
    // accepts — so the raw shape is wrapped once and handed to the host, which
    // validates incoming arguments against it before execute() runs.
    const input = z.object(def.args);
    const directory = this.#directory;
    const worktree = this.#worktree;
    return {
      name,
      description: def.description,
      input,
      async execute(args, context): Promise<Opencode2ToolResult> {
        const result = await def.execute(
          args,
          toCanonicalContext(context, directory, worktree),
        );
        return toToolResult(result);
      },
    };
  }
}
