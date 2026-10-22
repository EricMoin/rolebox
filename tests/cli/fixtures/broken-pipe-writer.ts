/**
 * Child process for `tests/cli/stdio-guard.test.ts`.
 *
 * It installs the real broken-pipe guard and then reproduces one of the two
 * ways a vanished reader reaches the process:
 *
 * - `stream` (default): write to stdout until the parent closes the read end.
 *   Without the guard Bun treats the resulting EPIPE as an unhandled stream
 *   error and dies with `EPIPE: broken pipe, write` plus a stack trace.
 * - `rejection`: reject a promise with EPIPE, the way `node:readline` throws a
 *   failed prompt redraw out of `@clack/prompts`' promise. Without the guard
 *   Bun reports an unhandled rejection and exits 1.
 *
 * With the guard either path exits quietly with the guard's broken-pipe status.
 *
 * Protocol: print READY first, then either tick every 10ms for at most five
 * seconds (stream mode, so the parent controls when the reader disappears) or
 * reject once (rejection mode).
 */
import { installBrokenPipeGuard } from "../../../src/cli/stdio-guard.ts";

const mode = process.argv[2] ?? "stream";

installBrokenPipeGuard();

process.stdout.write("READY\n");

if (mode === "rejection") {
  await Bun.sleep(50);
  void Promise.reject(
    Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }),
  );
  await Bun.sleep(5_000);
  process.exit(0);
}

const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  process.stdout.write("tick\n");
  await Bun.sleep(10);
}

process.exit(0);
