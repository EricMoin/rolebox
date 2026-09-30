/**
 * How a resolved executable is actually STARTED on this system.
 *
 * `CreateProcess` loads PE images. It cannot start a batch file, so Windows
 * gives `.cmd` and `.bat` a second starter: the command interpreter named by
 * `COMSPEC` (the same `commandShell` decision the descriptor already owns). An
 * npm-installed CLI on Windows IS such a file — the `pi.cmd` shim `PATHEXT`
 * lets a bare `pi` resolve to — so a spawn that hands the path straight to
 * `CreateProcess` fails with ENOENT while the shim sits right there.
 *
 * The shell route is not free: the command interpreter re-parses everything as
 * TEXT, so the executable and every argument must be quoted for it first. That
 * quoting is {@link escapeBatchArgument} / {@link escapeBatchCommand},
 * implemented from the rules <https://qntm.org/cmd> documents for cmd.exe (the
 * same algorithm cross-spawn uses to start a Windows `.cmd` shim), and
 * unit-tested in `tests/platform/system/spawn-command.test.ts`. The backslash
 * doubling follows CreateProcess's own rule exactly — 2N for a run of N, which
 * is what the callee's parser undoes; cross-spawn 7.0.6's backtracking-free
 * regexes emit N+1 for N >= 2, and that under-doubling is deliberately not
 * reproduced here.
 *
 * POSIX is untouched: every POSIX descriptor answers
 * {@link needsCommandShell} false, so the returned vector is exactly
 * `[executable, ...args]`, the same one this module replaced.
 */

import { win32 } from "node:path";
import { getSystem } from "./index.ts";

/** One resolved spawn: the argv to pass `spawn`, plus how to pass it. */
export interface SpawnCommand {
  /** `[executable, ...args]` — already the shell vector when the shell is needed. */
  readonly argv: readonly string[];
  /**
   * True when {@link argv} carries a command LINE this module quoted for the
   * command interpreter, so the spawn must hand the arguments through verbatim
   * instead of quoting them a second time (Node: `windowsVerbatimArguments`).
   * False on every direct spawn, where the arguments are ordinary argv.
   */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * The batch-script extensions the command interpreter runs instead of
 * `CreateProcess`.
 *
 * These two are the `PATHEXT` entries that are NOT PE images: `.exe`/`.com` are
 * started directly, and `PATHEXT` itself is only the LOOKUP rule that decides
 * which name a bare command resolves to. Execution is decided by the file, so
 * the extension — not the current `PATHEXT` value — is what routes a command
 * through the shell.
 */
const BATCH_SCRIPT_EXTENSIONS = [".cmd", ".bat"] as const;

/**
 * Whether `executable` can only run through this system's command shell.
 *
 * The path is parsed with Windows rules because a batch script only exists
 * there: the answer is false on every other system regardless of the name.
 */
export function needsCommandShell(executable: string): boolean {
  if (getSystem().id !== "win32") return false;
  const extension = win32.extname(executable).toLowerCase();
  return (BATCH_SCRIPT_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * The operators the command interpreter acts on. Caret-escaping every one of
 * them is what makes an arbitrary argument literal; the set (including the
 * space, which separates arguments) is cross-spawn's, from
 * <http://www.robvanderwoude.com/escapechars.php>.
 */
const COMMAND_OPERATORS = /([()\][%!^"`<>&|;, *?])/g;

/** Caret-escape a whole command, so the interpreter reads it as literal text. */
export function escapeBatchCommand(command: string): string {
  return command.replace(COMMAND_OPERATORS, "^$1");
}

/**
 * Quote one argument for the command interpreter, following the two
 * `CreateProcess` backslash rules the callee re-parses:
 *
 * 1. every run of backslashes immediately BEFORE a double quote is doubled,
 *    and that quote is written `\"` — so the callee's own parser reads one
 *    literal quote and keeps the backslashes it was given;
 * 2. a run of backslashes at the END of the argument is doubled for the same
 *    reason (the closing quote this function adds would otherwise escape it).
 *
 * The result is then wrapped in double quotes and caret-escaped, which is what
 * stops `&`, `|`, `<`, `>`, `%`, `!` and spaces from being read as operators by
 * the interpreter's first pass.
 */
export function escapeBatchArgument(argument: string): string {
  let escaped = "";
  for (let index = 0; index < argument.length; ) {
    const start = index;
    while (index < argument.length && argument[index] === "\\") index += 1;
    const backslashes = argument.slice(start, index);
    if (index === argument.length) {
      // Rule 2: trailing backslashes precede the closing quote this function adds.
      escaped += backslashes + backslashes;
    } else if (argument[index] === "\"") {
      // Rule 1: backslashes before a quote, and the quote itself.
      escaped += backslashes + backslashes + "\\\"";
      index += 1;
    } else {
      escaped += backslashes + argument[index];
      index += 1;
    }
  }
  return `"${escaped}"`.replace(COMMAND_OPERATORS, "^$1");
}

/**
 * Resolve how to start `executable` with `args` on this system.
 *
 * A batch script becomes a command line for this system's shell — the
 * descriptor's `commandShell`, so `COMSPEC` (and every future shell decision)
 * has exactly one owner — and everything else stays a direct spawn with the
 * caller's own argv.
 */
export function resolveSpawnCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnCommand {
  if (!needsCommandShell(executable)) {
    return { argv: [executable, ...args], windowsVerbatimArguments: false };
  }
  const command = [escapeBatchCommand(executable), ...args.map(escapeBatchArgument)].join(" ");
  // The interpreter takes the command as ONE argument after `/c`, and `/s`
  // strips the outer pair of quotes around it — the form cross-spawn uses.
  return { argv: [...getSystem().commandShell(`"${command}"`, env)], windowsVerbatimArguments: true };
}
