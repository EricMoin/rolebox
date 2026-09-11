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
 *   read   — read output: raw stream, or (pty) the rendered screen snapshot.
 *   resize — resize the terminal (PTY backend only).
 *   close  — terminate a session (graceful, then SIGKILL).
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
  isTuiSession,
  type TerminalSession,
} from "./session-registry.ts";

const log = createSubLogger("interactive-terminal-tool");

// ── Keystroke handling ───────────────────────────────────────────────────────

/**
 * Named keys accepted by the `keys` argument (and `data` when a token is
 * wrapped in `<...>`, e.g. "<enter>"). Case-insensitive.
 */
const NAMED_KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  cr: "\r",
  newline: "\n",
  lf: "\n",
  tab: "\t",
  space: " ",
  backspace: "\u007f",
  bs: "\u0008",
  escape: "\u001b",
  esc: "\u001b",
  delete: "\u001b[3~",
  del: "\u001b[3~",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  insert: "\u001b[2~",
  f1: "\u001bOP",
  f2: "\u001bOQ",
  f3: "\u001bOR",
  f4: "\u001bOS",
  f5: "\u001b[15~",
  f6: "\u001b[17~",
  f7: "\u001b[18~",
  f8: "\u001b[19~",
  f9: "\u001b[20~",
  f10: "\u001b[21~",
  f11: "\u001b[23~",
  f12: "\u001b[24~",
};

/** Resolve a single named-key token like "enter", "ctrl+c", "alt+x", "f5". */
function resolveNamedKey(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (NAMED_KEYS[t] !== undefined) return NAMED_KEYS[t];
  // ctrl+X / c-X → control byte.
  let m = /^(?:ctrl|c|control)[+-](.)$/.exec(t);
  if (m) {
    const c = m[1].toUpperCase().charCodeAt(0);
    if (c >= 63 && c <= 95) return String.fromCharCode(c === 63 ? 127 : c - 64); // ^? and ^A..^_
    if (m[1] === " ") return "\u0000";
    return null;
  }
  // alt+X / meta+X → ESC prefix.
  m = /^(?:alt|meta|m)[+-](.+)$/.exec(t);
  if (m) {
    const inner = resolveNamedKey(m[1]) ?? (m[1].length === 1 ? m[1] : null);
    return inner === null ? null : "\u001b" + inner;
  }
  return null;
}

/**
 * Decode the documented `data` input syntax into real bytes:
 *   - `\uXXXX` / `\xXX` hex escapes (e.g. `\u0003` → Ctrl-C, `\u001b` → ESC)
 *   - C-style escapes `\r` `\n` `\t` `\b` `\f` `\e` `\0` `\\`
 *   - named keys wrapped in angle brackets, e.g. `<enter>`, `<up>`, `<ctrl+c>`
 * Anything that is not a well-formed escape passes through untouched, so
 * plain text containing literal backslashes or `<` is preserved.
 */
export function decodeKeystrokeEscapes(data: string): string {
  return data.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\([rntbfe0\\])|<([a-zA-Z0-9+_-]{1,12})>/g,
    (whole, uBrace: string, u4: string, x2: string, c: string, named: string) => {
      if (uBrace) return String.fromCodePoint(parseInt(uBrace, 16));
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (x2) return String.fromCharCode(parseInt(x2, 16));
      if (c) {
        return { r: "\r", n: "\n", t: "\t", b: "\b", f: "\f", e: "\u001b", "0": "\u0000", "\\": "\\" }[c]!;
      }
      if (named !== undefined) {
        const resolved = resolveNamedKey(named);
        return resolved !== null ? resolved : whole;
      }
      return whole;
    },
  );
}

/** Human-readable preview of what was written (control bytes escaped). */
function previewBytes(s: string, max = 80): string {
  const printable = [...s]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c === 0x1b) return "\\e";
      if (c === 0x0d) return "\\r";
      if (c === 0x0a) return "\\n";
      if (c === 0x09) return "\\t";
      if (c < 0x20 || c === 0x7f) return `\\x${c.toString(16).padStart(2, "0")}`;
      return ch;
    })
    .join("");
  return printable.length > max ? printable.slice(0, max) + "…" : printable;
}

function describe(sess: TerminalSession): Record<string, unknown> {
  return {
    id: sess.id,
    backend: sess.backend,
    command: sess.command,
    alive: sess.alive,
    exitCode: sess.exitCode,
    exitSignal: sess.exitSignal,
    cols: sess.cols,
    rows: sess.rows,
    tui: isTuiSession(sess),
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
      "Actions: open | write | read | resize | close | list. " +
      "WRITE input syntax: plain text plus escapes \\r \\n \\t \\e, \\uXXXX/\\xXX hex, and " +
      "named keys in angle brackets: <enter> <esc> <tab> <up> <down> <left> <right> " +
      "<ctrl+c> <ctrl+d> <alt+x> <f1>..<f12>. On a PTY, append_newline sends Enter (\\r) — " +
      "the correct submit key for TUIs. " +
      "READ modes: 'stream' returns raw new output since the last read; 'screen' (PTY only) " +
      "returns the current rendered screen snapshot — like tmux capture-pane — which is the " +
      "right way to observe full-screen TUIs that repaint in place; 'auto' (default) picks " +
      "'screen' automatically once the app behaves like a full-screen TUI. " +
      "Prefer `until` (regex) or `wait_ms` (quiet period) over fixed sleeps; the result " +
      "reports matched/timed-out status honestly.",
    args: {
      action: z.enum(["open", "write", "read", "resize", "close", "list"]),
      /** Session id. Returned by `open`; required for write/read/resize/close.
       *  On open, a custom id may be requested (sanitized; suffixed on collision). */
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
      data: z.string().optional().describe(
        "Text/keystrokes to send (write). Supports \\uXXXX/\\xXX and \\r \\n \\t \\e escapes " +
        "plus named keys like <enter>, <esc>, <ctrl+c>, <up>. Example: 'hello<enter>'.",
      ),
      keys: z.array(z.string()).optional().describe(
        "Named keys to send (write), e.g. [\"escape\", \"ctrl+c\", \"enter\", \"f5\"]. " +
        "Sent after `data` if both are given. Unknown key names are rejected.",
      ),
      append_newline: z.boolean().optional().describe(
        "Append Enter after `data` (write, default true when `keys` is absent; " +
        "\\r on a PTY, \\n on pipes). Set false for raw keystrokes.",
      ),
      // read
      mode: z.enum(["auto", "stream", "screen"]).optional().describe(
        "Read view (read). 'stream' = raw new output; 'screen' = rendered screen snapshot " +
        "(PTY only, best for full-screen TUIs); 'auto' (default) = screen for TUIs, else stream.",
      ),
      wait_ms: z.number().int().nonnegative().optional().describe("Block until output is quiet for this long (read)."),
      until: z.string().optional().describe("Block until this regex matches (read) — tested against the ANSI-stripped stream or the screen snapshot."),
      timeout_ms: z.number().int().positive().optional().describe("Overall wait budget for a blocking read."),
      from_start: z.boolean().optional().describe("Return the whole retained buffer, not just new output (read, stream view)."),
      strip_ansi: z.boolean().optional().describe("Strip ANSI escape sequences from stream output (read, default true)."),
      // close
      signal: z.string().optional().describe("Kill signal for close (e.g. SIGTERM, SIGINT, SIGKILL). Escalates to SIGKILL if the process survives."),
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
            requestedId: input.id,
          });
          log.debug("opened", { id: sess.id, backend: sess.backend });
          // openSession already waited for the program's first output.
          const initial = await readSession(sess, { abort: context.abort });
          const hints: string[] = [];
          if (sess.backend === "pipe") {
            hints.push(
              "pipe backend — line-oriented programs only (no full-screen TUI). Install node-pty for a real PTY.",
            );
          } else {
            hints.push(
              "pty backend — full interactive/TUI support. Submit input with <enter> (\\r); " +
                "read full-screen apps with mode \"screen\".",
            );
          }
          if (!sess.alive) {
            hints.push(`process already exited with code ${sess.exitCode}.`);
          } else if (initial.text.length === 0) {
            hints.push("no initial output yet — the program may still be starting; read again with wait_ms/until.");
          }
          return {
            title: `terminal ${sess.id} (${sess.backend})`,
            output: JSON.stringify(
              { ...describe(sess), note: hints.join(" "), initial_output: initial.text },
              null,
              2,
            ),
            metadata: { id: sess.id, backend: sess.backend, alive: sess.alive },
          };
        }

        case "write": {
          if (!input.id) throw new Error("`id` is required for write");
          if (input.data == null && !input.keys?.length)
            throw new Error("`data` or `keys` is required for write");
          const sess = getOwned(owner, input.id);

          let payload = "";
          if (input.data != null) payload += decodeKeystrokeEscapes(input.data);
          if (input.keys?.length) {
            for (const key of input.keys) {
              const resolved = resolveNamedKey(key);
              if (resolved === null) {
                throw new Error(
                  `Unknown key name "${key}". Use names like enter, escape, tab, up, down, ` +
                    `ctrl+c, alt+x, f1..f12.`,
                );
              }
              payload += resolved;
            }
          }
          // Default: submit the line. On a PTY, Enter is \r (what a keyboard
          // sends and what TUIs bind); on pipes, \n terminates the line.
          const appendNewline = input.append_newline ?? !input.keys?.length;
          if (appendNewline) payload += sess.backend === "pty" ? "\r" : "\n";
          writeSession(sess, payload);
          return `wrote ${payload.length} char(s) to ${sess.id}: "${previewBytes(payload)}"`;
        }

        case "read": {
          if (!input.id) throw new Error("`id` is required for read");
          const sess = getOwned(owner, input.id);
          const res = await readSession(sess, {
            waitMs: input.wait_ms,
            until: input.until,
            timeoutMs: input.timeout_ms,
            fromStart: input.from_start,
            stripAnsi: input.strip_ansi ?? true,
            mode: input.mode,
            abort: context.abort,
          });
          const notes: string[] = [];
          if (res.mode === "screen") {
            notes.push(res.screenChanged ? "screen snapshot (changed)" : "screen snapshot (unchanged since last read)");
          }
          if (res.matched === true) notes.push("`until` pattern matched");
          if (res.matched === false && res.timedOut) notes.push("TIMEOUT — `until` pattern did NOT match within the wait budget");
          else if (res.timedOut) notes.push("timed out waiting for quiet output");
          if (res.aborted) notes.push("read aborted");
          if (res.truncated) notes.push("output truncated to the most recent portion");
          if (!sess.alive) notes.push(`process exited (code ${sess.exitCode}${sess.exitSignal ? `, signal ${sess.exitSignal}` : ""})`);
          const header = notes.length ? `[${notes.join("; ")}]\n` : "";
          return {
            title: `terminal ${sess.id} ${res.mode === "screen" ? "screen" : "output"}`,
            output: header + (res.text.length ? res.text : "(no new output)"),
            metadata: {
              id: sess.id,
              alive: sess.alive,
              exitCode: sess.exitCode,
              mode: res.mode,
              matched: res.matched,
              timedOut: res.timedOut,
              truncated: res.truncated,
              tui: isTuiSession(sess),
            },
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
          const sess = await closeSession(owner, input.id, input.signal);
          const how = sess.exitSignal ? `signal ${sess.exitSignal}` : `exitCode ${sess.exitCode}`;
          return `closed ${sess.id} (${how})`;
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
