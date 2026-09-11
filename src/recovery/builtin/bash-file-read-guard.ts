import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:bash-read-guard");

/**
 * Regex pattern that detects file-reading commands in bash.
 * Matches the command name at the start of a command invocation.
 */
const FILE_READ_PATTERN = /^(cat|head|tail|less|more|dd)\s+/;

/**
 * Creates the bash-file-read-guard built-in hook.
 *
 * Intercepts `bash` tool calls before execution and detects commands
 * that read file contents (cat, head, tail, less, more, dd). Injects
 * a reminder to use the Read, Grep, or Glob tools instead, which
 * provide structured access without shell overhead.
 *
 * No engine dependency — pure guard with direct injection.
 *
 * @returns A configured BuiltInHookDefinition
 */
export function createBashFileReadGuardHook(): BuiltInHookDefinition {
  return {
    name: "bash-file-read-guard",
    configKey: "bash_file_read_guard",
    events: ["tool.execute.before"],
    phase: "before",
    priority: 10,
    filter: { tools: ["bash"] },
    module: {
      onToolBefore: async (
        ctx: unknown,
        input: { tool: string; args: unknown },
      ) => {
        const hookCtx = ctx as { inject: (text: string) => void };

        const command = extractCommand(input.args);
        if (!command) return;

        if (FILE_READ_PATTERN.test(command.trim())) {
          log.debug("Bash read guard triggered", { command: command.slice(0, 80) });

          // Extract the command name for a specific message
          const cmdName = command.trim().split(/\s+/)[0] ?? "cat";

          hookCtx.inject(
            `\n[GUARD] Detected file read via bash (${cmdName}). ` +
              `Use the Read tool to view file contents, Grep to search ` +
              `file contents, or Glob to find files by name pattern. ` +
              `These tools provide structured access with line numbers ` +
              `and content formatting.\n`,
          );
        }
      },
    },
  };
}

/**
 * Extract the command string from unstructured bash tool arguments.
 */
function extractCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  // Some tool descriptions may wrap command in a different field
  if (typeof obj.cmd === "string") return obj.cmd;
  return null;
}
