/**
 * interactive-terminal-tool.ts — the `interactive_terminal` tool.
 *
 * A single multiplexed tool that drives persistent interactive terminal
 * sessions (REPLs, prompts, and full-screen TUIs when a real PTY is
 * available). Unlike a one-shot bash tool, a session stays alive between
 * calls so the model can send input and read evolving output.
 *
 * Actions:
 *   open   — start a session (returns an id). Gated via context.ask().
 *   write  — send input/keystrokes to a session.
 *   read   — read buffered output (optionally blocking until quiet/pattern).
 *   resize — resize the terminal (PTY backend only).
 *   close  — terminate a session.
 *   list   — list this session's live terminals.
 */

import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { createSubLogger } from "../logger.ts";
import {
  openSession,
  getOwned,
  writeSession,
  readSession,
  resizeSession,
  closeSession,
  listSessions,
  type TerminalSession,
} from "./session-registry.ts";

const log = createSubLogger("interactive-terminal-tool");

/**
 * Decode documented `\uXXXX` keystroke escapes into real control characters
 * (e.g. `\u001b` → ESC, `\u0003` → Ctrl-C, `\u000d` → CR). This is the
 * tool's documented input syntax (see the `data` arg description) — without
 * it, control keys can never be sent and TUIs like vim are undrivable.
 * Anything that is not a well-formed `\uXXXX` sequence passes through
 * untouched, so plain text with literal `\u` in it is preserved.
 */
function decodeKeystrokeEscapes(data: string): string {
  return data.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function describe(sess: TerminalSession): Record<string, unknown> {
  return {
    id: sess.id,
    backend: sess.backend,
    command: sess.command,
    alive: sess.alive,
    exitCode: sess.exitCode,
    exitSignal: sess.exitSignal,
    createdAt: sess.createdAt,
  };
}

export function createInteractiveTerminalTool() {
  return defineTool({
    description:
      "Drive a PERSISTENT, interactive terminal session — for REPLs, interactive " +
      "prompts, and full-screen TUI apps (vim/htop/etc.) — as opposed to one-shot " +
      "'one command → one result' execution. A session stays alive across calls so " +
      "you can send input and read evolving output. Backend is hybrid: a real PTY " +
      "(node-pty) when available, otherwise line-oriented pipes (no full-screen TUI). " +
      "Actions: open | write | read | resize | close | list.",
    args: {
      action: z.enum(["open", "write", "read", "resize", "close", "list"]),
      /** Session id returned by `open`; required for write/read/resize/close. */
      id: z.string().optional(),
      // open
      command: z.string().optional().describe("Program to run (open). Defaults to $SHELL."),
      args: z.array(z.string()).optional().describe("Program arguments (open)."),
      shell: z.boolean().optional().describe("Run `command` through the system shell (open)."),
      backend: z.enum(["auto", "pty", "pipe"]).optional().describe(
        "Backend preference (open). 'auto' (default) prefers a real PTY (full TUI support), " +
        "falling back to pipes. 'pipe' forces line-oriented mode (use under the Bun runtime, " +
        "where node-pty is unreliable).",
      ),
      cwd: z.string().optional().describe("Working directory (open)."),
      env: z.record(z.string(), z.string()).optional().describe("Extra env vars (open)."),
      cols: z.number().int().positive().optional().describe("Terminal columns (open/resize)."),
      rows: z.number().int().positive().optional().describe("Terminal rows (open/resize)."),
      idle_timeout_ms: z.number().int().positive().optional().describe("Auto-kill after idle (open)."),
      // write
      data: z.string().optional().describe("Text/keystrokes to send (write). Use e.g. '\\u0003' for Ctrl-C."),
      append_newline: z.boolean().optional().describe("Append a newline after `data` (write, default true)."),
      // read
      wait_ms: z.number().int().nonnegative().optional().describe("Block until output is quiet for this long (read)."),
      until: z.string().optional().describe("Block until this regex matches new output (read)."),
      timeout_ms: z.number().int().positive().optional().describe("Overall wait budget for a blocking read."),
      from_start: z.boolean().optional().describe("Return the whole retained buffer, not just new output (read)."),
      strip_ansi: z.boolean().optional().describe("Strip ANSI escape sequences from output (read)."),
      // close
      signal: z.string().optional().describe("Kill signal for close (e.g. SIGTERM, SIGINT, SIGKILL)."),
    },
    async execute(input, context) {
      const owner = context.sessionID;

      switch (input.action) {
        case "open": {
          const cmdline = [input.command ?? "$SHELL", ...(input.args ?? [])].join(" ");
          // Best-effort permission gate. Real prompt on pi; no-op on dsh.
          try {
            await context.ask({
              permission: "interactive_terminal",
              patterns: [cmdline],
              always: [],
              metadata: { command: input.command ?? null, args: input.args ?? [], shell: !!input.shell },
            });
          } catch (err) {
            return `interactive_terminal: open denied — ${(err as Error).message}`;
          }
          const sess = await openSession(owner, {
            command: input.command,
            args: input.args,
            shell: input.shell,
            backend: input.backend,
            cwd: input.cwd || context.directory,
            env: input.env,
            cols: input.cols,
            rows: input.rows,
            idleTimeoutMs: input.idle_timeout_ms,
          });
          log.debug("opened", { id: sess.id, backend: sess.backend });
          // Give the program a moment to print an initial prompt/banner.
          const initial = await readSession(sess, { abort: context.abort });
          return {
            title: `terminal ${sess.id} (${sess.backend})`,
            output: JSON.stringify(
              {
                ...describe(sess),
                note:
                  sess.backend === "pipe"
                    ? "pipe backend — line-oriented programs only (no full-screen TUI). Install node-pty for a real PTY."
                    : "pty backend — full interactive/TUI support.",
                initial_output: initial,
              },
              null,
              2,
            ),
            metadata: { id: sess.id, backend: sess.backend },
          };
        }

        case "write": {
          if (!input.id) throw new Error("`id` is required for write");
          if (input.data == null) throw new Error("`data` is required for write");
          const sess = getOwned(owner, input.id);
          const decoded = decodeKeystrokeEscapes(input.data);
          const payload = decoded + (input.append_newline === false ? "" : "\n");
          writeSession(sess, payload);
          return `wrote ${payload.length} char(s) to ${sess.id}`;
        }

        case "read": {
          if (!input.id) throw new Error("`id` is required for read");
          const sess = getOwned(owner, input.id);
          const out = await readSession(sess, {
            waitMs: input.wait_ms,
            until: input.until,
            timeoutMs: input.timeout_ms,
            fromStart: input.from_start,
            stripAnsi: input.strip_ansi,
            abort: context.abort,
          });
          return {
            title: `terminal ${sess.id} output`,
            output: out.length ? out : "(no new output)",
            metadata: { id: sess.id, alive: sess.alive, exitCode: sess.exitCode },
          };
        }

        case "resize": {
          if (!input.id) throw new Error("`id` is required for resize");
          if (input.cols == null || input.rows == null)
            throw new Error("`cols` and `rows` are required for resize");
          const sess = getOwned(owner, input.id);
          resizeSession(sess, input.cols, input.rows);
          const note = sess.backend === "pipe" ? " (pipe backend — resize is a no-op)" : "";
          return `resized ${sess.id} to ${input.cols}x${input.rows}${note}`;
        }

        case "close": {
          if (!input.id) throw new Error("`id` is required for close");
          const sess = closeSession(owner, input.id, input.signal);
          return `closed ${sess.id} (exitCode ${sess.exitCode})`;
        }

        case "list": {
          const list = listSessions(owner).map(describe);
          return {
            title: `${list.length} terminal session(s)`,
            output: JSON.stringify(list, null, 2),
          };
        }
      }
    },
  });
}
