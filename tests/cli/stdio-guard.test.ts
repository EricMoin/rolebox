import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BROKEN_PIPE_EXIT_CODE,
  installBrokenPipeGuard,
  isBrokenPipeError,
  type FatalEventSource,
} from "../../src/cli/stdio-guard.ts";

/** A stand-in for stdout/stderr: an emitter that records what was written. */
interface FakeStream extends EventEmitter {
  written: string[];
  write(chunk: string): boolean;
}

function fakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.written = [];
  stream.write = (chunk: string): boolean => {
    stream.written.push(chunk);
    return true;
  };
  return stream;
}

/** A stand-in for the fatal process events, so tests never patch `process`. */
function fakeFatalEvents(): EventEmitter & FatalEventSource {
  return new EventEmitter() as EventEmitter & FatalEventSource;
}

function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
}

describe("isBrokenPipeError", () => {
  it("recognizes the OS's EPIPE code", () => {
    expect(isBrokenPipeError(brokenPipe())).toBe(true);
    // Bun reports it as a plain object-shaped error on some paths; only `code` matters.
    expect(isBrokenPipeError({ code: "EPIPE" })).toBe(true);
  });

  it("is not fooled by the message, a different errno, or a non-error", () => {
    expect(isBrokenPipeError(new Error("EPIPE: broken pipe, write"))).toBe(false);
    expect(isBrokenPipeError(Object.assign(new Error("gone"), { code: "EIO" }))).toBe(false);
    expect(isBrokenPipeError(undefined)).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
    expect(isBrokenPipeError("EPIPE")).toBe(false);
  });
});

describe("installBrokenPipeGuard — stdio streams", () => {
  it("exits 141 with nothing printed when stdout's reader disappears", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const exits: number[] = [];
    let restored = 0;

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents: fakeFatalEvents(),
      exit: (code) => exits.push(code),
      restoreTerminal: () => {
        restored += 1;
      },
    });

    stdout.emit("error", brokenPipe());

    expect(exits).toEqual([BROKEN_PIPE_EXIT_CODE]);
    expect(restored).toBe(1);
    // The stream that just failed is not written to, and stderr stays silent:
    // there is nobody left to read a diagnosis of a broken pipe.
    expect(stderr.written).toEqual([]);
    expect(stdout.written).toEqual([]);
  });

  it("treats a broken stderr the same way, so the crash never escapes", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const exits: number[] = [];
    let restored = 0;

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents: fakeFatalEvents(),
      exit: (code) => exits.push(code),
      restoreTerminal: () => {
        restored += 1;
      },
    });

    stderr.emit("error", brokenPipe());

    expect(exits).toEqual([BROKEN_PIPE_EXIT_CODE]);
    expect(restored).toBe(1);
  });

  it("reports any other stdio error on stderr and exits 1 instead of exiting 141", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const exits: number[] = [];

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents: fakeFatalEvents(),
      exit: (code) => exits.push(code),
      restoreTerminal: () => {
        throw new Error("must not restore for a non-EPIPE failure");
      },
    });

    stdout.emit("error", Object.assign(new Error("I/O failure"), { code: "EIO" }));

    expect(exits).toEqual([1]);
    expect(stderr.written).toEqual(["rolebox: stdio error: I/O failure\n"]);
  });

  it("stops listening once disposed", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const fatalEvents = fakeFatalEvents();
    const exits: number[] = [];

    const dispose = installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents,
      exit: (code) => exits.push(code),
      restoreTerminal: () => {},
    });
    expect(stdout.listenerCount("error")).toBe(1);
    dispose();

    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    expect(fatalEvents.listenerCount("uncaughtExceptionMonitor")).toBe(0);
    expect(fatalEvents.listenerCount("unhandledRejection")).toBe(0);
    expect(exits).toEqual([]);
  });
});

describe("installBrokenPipeGuard — process-fatal events", () => {
  it("ends quietly when EPIPE arrives as an unhandled rejection", () => {
    // This is the interactive-prompt crash: node:readline throws the failed
    // redraw out of @clack/prompts' promise, so it reaches the process as a
    // rejection — not as a stream `error` event the stream listener would see.
    const stdout = fakeStream();
    const stderr = fakeStream();
    const fatalEvents = fakeFatalEvents();
    const exits: number[] = [];
    let restored = 0;

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents,
      exit: (code) => exits.push(code),
      restoreTerminal: () => {
        restored += 1;
      },
    });

    fatalEvents.emit("unhandledRejection", brokenPipe());

    expect(exits).toEqual([BROKEN_PIPE_EXIT_CODE]);
    expect(restored).toBe(1);
    expect(stderr.written).toEqual([]);
  });

  it("ends quietly when EPIPE arrives as an uncaught exception", () => {
    // The monitor event is observed before the runtime reports the crash, so
    // this path can end the process without a report.
    const stdout = fakeStream();
    const stderr = fakeStream();
    const fatalEvents = fakeFatalEvents();
    const exits: number[] = [];

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents,
      exit: (code) => exits.push(code),
      deferExit: () => {
        throw new Error("must not defer for a broken pipe");
      },
      restoreTerminal: () => {},
    });

    fatalEvents.emit("uncaughtExceptionMonitor", brokenPipe());

    expect(exits).toEqual([BROKEN_PIPE_EXIT_CODE]);
  });

  it("keeps a non-EPIPE uncaught exception fatal without replacing the runtime report", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const fatalEvents = fakeFatalEvents();
    const exits: number[] = [];
    const deferred: number[] = [];

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents,
      exit: (code) => exits.push(code),
      deferExit: (code) => deferred.push(code),
      restoreTerminal: () => {},
    });

    fatalEvents.emit("uncaughtExceptionMonitor", new Error("a real bug"));

    // The runtime printed the report after the monitor event; the guard only
    // makes sure the process does not keep running past it.
    expect(deferred).toEqual([1]);
    expect(exits).toEqual([]);
  });

  it("hands a non-EPIPE rejection back to the runtime instead of swallowing it", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const fatalEvents = fakeFatalEvents();
    const exits: number[] = [];
    const rerejected: unknown[] = [];
    const crash = new Error("a real bug");

    installBrokenPipeGuard({
      stdout,
      stderr,
      fatalEvents,
      exit: (code) => exits.push(code),
      rereject: (error) => rerejected.push(error),
      restoreTerminal: () => {},
    });

    fatalEvents.emit("unhandledRejection", crash);

    // The guard steps out of the way completely: the runtime's own report and
    // exit 1 are what a developer sees, exactly as if no listener existed.
    expect(rerejected).toEqual([crash]);
    expect(exits).toEqual([]);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
    expect(fatalEvents.listenerCount("unhandledRejection")).toBe(0);
  });
});

// ── Cross-process regression ──────────────────────────────────────────────
// The unit tests above prove the plumbing; these prove the actual failures a
// user reported in a real Bun process: a broken pipe must end the process
// quietly instead of producing Bun's `EPIPE: broken pipe, write` crash report.
const FIXTURE = fileURLToPath(new URL("./fixtures/broken-pipe-writer.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface WriterResult {
  code: number | null;
  stderr: string;
}

function runWriter(mode: "stream" | "rejection"): Promise<WriterResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", FIXTURE, mode], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`broken-pipe fixture did not exit; stderr: ${stderr}`));
    }, 20_000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.once("data", () => {
      if (mode !== "stream") return;
      // The fixture is up and writing: drop the read end, so its next write
      // hits EPIPE exactly as a closed terminal or a detached PTY would.
      child.stdout.destroy();
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, stderr });
    });
  });
}

describe("broken-pipe guard across a real OS process", () => {
  it("ends quietly with the SIGPIPE status instead of crashing with a stack trace", async () => {
    const { code, stderr } = await runWriter("stream");

    expect(stderr).not.toContain("EPIPE");
    expect(stderr).not.toContain("writeFast");
    expect(code).toBe(BROKEN_PIPE_EXIT_CODE);
  }, 25_000);

  it("ends quietly when the EPIPE reaches the process as a rejection", async () => {
    const { code, stderr } = await runWriter("rejection");

    expect(stderr).not.toContain("EPIPE");
    expect(stderr).not.toContain("Unhandled");
    expect(code).toBe(BROKEN_PIPE_EXIT_CODE);
  }, 25_000);
});
