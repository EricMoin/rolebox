import { existsSync } from "node:fs";
import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:write-file-guard");

/**
 * Creates the write-existing-file-guard built-in hook.
 *
 * Intercepts `write` tool calls before execution and checks whether
 * the target file already exists. When an existing file is being
 * overwritten, injects a warning reminder to use Read first.
 *
 * No engine dependency — pure guard with direct injection.
 *
 * @returns A configured BuiltInHookDefinition
 */
export function createWriteExistingFileGuardHook(): BuiltInHookDefinition {
  return {
    name: "write-existing-file-guard",
    configKey: "write_existing_file_guard",
    events: ["tool.execute.before"],
    phase: "before",
    priority: 10,
    filter: { tools: ["write"] },
    module: {
      onToolBefore: async (
        ctx: unknown,
        input: { tool: string; args: unknown },
      ) => {
        const hookCtx = ctx as { inject: (text: string) => void };

        const filePath = extractFilePath(input.args);
        if (!filePath) return;

        if (existsSync(filePath)) {
          log.debug("Write guard triggered — file exists", { filePath });
          hookCtx.inject(
            `\n[GUARD] File already exists: "${filePath}". ` +
              `Use the Read tool to view the current content before ` +
              `overwriting with the Write tool. If you intend to edit ` +
              `specific lines, use the Edit or hashline_edit tool instead.\n`,
          );
        }
      },
    },
  };
}

/**
 * Extract the filePath from unstructured tool arguments.
 */
function extractFilePath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  if (typeof obj.filePath === "string") return obj.filePath;
  if (typeof obj.path === "string") return obj.path;
  return null;
}
