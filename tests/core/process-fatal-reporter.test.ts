import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessFatalReporter,
  type ProcessFatalEntry,
} from "../../src/core/process-fatal-reporter.ts";

/**
 * Spy listener target: records exactly which (event, listener) pairs are added
 * and removed, so a test can invoke the registered handler by identity.
 */
function makeTarget() {
  const listeners = new Map<string, (arg: unknown) => void>();
  const removed: Array<{ event: string; listener: (arg: unknown) => void }> = [];
  return {
    listeners,
    removed,
    on: mock((event: string, listener: (arg: unknown) => void) => {
      listeners.set(event, listener);
    }),
    off: mock((event: string, listener: (arg: unknown) => void) => {
      removed.push({ event, listener });
      listeners.delete(event);
    }),
  };
}

/**
 * Counting listener target: like makeTarget, but it also reports a live
 * listenerCount per event, so the sole-owner exit policy can be exercised and
 * a pre-existing host handler can be registered before install().
 */
function makeCountingTarget() {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  return {
    listeners,
    on: mock((event: string, listener: (arg: unknown) => void) => {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
    }),
    off: mock((event: string, listener: (arg: unknown) => void) => {
      const registered = listeners.get(event) ?? [];
      listeners.set(event, registered.filter((entry) => entry !== listener));
    }),
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
  };
}

describe("ProcessFatalReporter", () => {
  it("install adds exactly two listeners and uninstall removes exactly those", () => {
    const target = makeTarget();
    const reporter = new ProcessFatalReporter({ target: target as any, report: () => {} });

    const uninstall = reporter.install();

    expect(target.on).toHaveBeenCalledTimes(2);
    expect(target.on.mock.calls.map((c) => c[0])).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
    const registered = new Map(target.on.mock.calls.map((c) => [c[0], c[1]]));

    uninstall();

    expect(target.off).toHaveBeenCalledTimes(2);
    for (const [event, listener] of target.off.mock.calls) {
      expect(registered.get(event)).toBe(listener);
    }
    expect(target.listeners.size).toBe(0);
  });

  it("balances the host process listener counts and uninstall is idempotent", () => {
    const beforeUncaught = process.listenerCount("uncaughtException");
    const beforeRejection = process.listenerCount("unhandledRejection");

    const reporter = new ProcessFatalReporter({ report: () => {} });
    const uninstall = reporter.install();
    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection + 1);

    uninstall();
    uninstall(); // idempotent — no double removal
    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection);
  });

  it("install is idempotent — a second install adds no listeners", () => {
    const target = makeTarget();
    const reporter = new ProcessFatalReporter({ target: target as any, report: () => {} });

    reporter.install();
    reporter.install();

    expect(target.on).toHaveBeenCalledTimes(2);
  });

  it("invoking the registered handler logs one entry, never throws and never exits", () => {
    const target = makeTarget();
    const entries: ProcessFatalEntry[] = [];
    const flush = mock(() => {});
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    (process as any).exit = exitSpy;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        flush,
        report: (entry) => entries.push(entry),
      });
      reporter.install();
      const handler = target.listeners.get("uncaughtException");
      expect(handler).toBeDefined();

      expect(() => handler!(new Error("boom"))).not.toThrow();

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("uncaughtException");
      expect(entries[0].message).toBe("boom");
      expect(entries[0].stack).toContain("boom");
      expect(entries[0].timestamp.length).toBeGreaterThan(0);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      (process as any).exit = originalExit;
    }
  });

  it("handles a non-Error unhandledRejection reason", () => {
    const target = makeTarget();
    const entries: ProcessFatalEntry[] = [];
    const reporter = new ProcessFatalReporter({
      target: target as any,
      flush: () => {},
      report: (entry) => entries.push(entry),
    });
    reporter.install();

    const handler = target.listeners.get("unhandledRejection");
    expect(() => handler!("rejected with a string")).not.toThrow();

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("unhandledRejection");
    expect(entries[0].message).toBe("rejected with a string");
  });

  it("a second fatal event is a no-op — flush and log happen exactly once", () => {
    const target = makeTarget();
    const entries: ProcessFatalEntry[] = [];
    const flush = mock(() => {});
    const reporter = new ProcessFatalReporter({
      target: target as any,
      flush,
      report: (entry) => entries.push(entry),
    });
    reporter.install();

    const handler = target.listeners.get("uncaughtException")!;
    handler(new Error("first"));
    handler(new Error("second"));
    handler(new Error("third"));

    expect(flush).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("first");
  });

  it("never throws when the flush or the report sink throws", () => {
    const target = makeTarget();
    const reporter = new ProcessFatalReporter({
      target: target as any,
      flush: () => {
        throw new Error("flush exploded");
      },
      report: () => {
        throw new Error("report exploded");
      },
    });
    reporter.install();

    const handler = target.listeners.get("unhandledRejection")!;
    expect(() => handler(new Error("boom"))).not.toThrow();
  });

  it("writes nothing to stderr by default", () => {
    const target = makeTarget();
    const writes: string[] = [];
    const originalWrite = (process.stderr as any).write;
    (process.stderr as any).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    const previousEnv = process.env.ROLEBOX_FATAL_STDERR;
    delete process.env.ROLEBOX_FATAL_STDERR;

    try {
      const reporter = new ProcessFatalReporter({ target: target as any, report: () => {} });
      reporter.handle("uncaughtException", new Error("quiet"));
      expect(writes).toEqual([]);
    } finally {
      (process.stderr as any).write = originalWrite;
      if (previousEnv === undefined) delete process.env.ROLEBOX_FATAL_STDERR;
      else process.env.ROLEBOX_FATAL_STDERR = previousEnv;
    }
  });

  it("writes exactly one stderr line when ROLEBOX_FATAL_STDERR=1", () => {
    const target = makeTarget();
    const writes: string[] = [];
    const originalWrite = (process.stderr as any).write;
    (process.stderr as any).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    const previousEnv = process.env.ROLEBOX_FATAL_STDERR;
    process.env.ROLEBOX_FATAL_STDERR = "1";

    try {
      const reporter = new ProcessFatalReporter({ target: target as any, report: () => {} });
      reporter.handle("unhandledRejection", new Error("loud"));

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("unhandledRejection");
      expect(writes[0]).toContain("loud");
    } finally {
      (process.stderr as any).write = originalWrite;
      if (previousEnv === undefined) delete process.env.ROLEBOX_FATAL_STDERR;
      else process.env.ROLEBOX_FATAL_STDERR = previousEnv;
    }
  });

  it("exits 1 on a sole-owner uncaughtException — the crash is not swallowed", () => {
    const target = makeCountingTarget();
    const entries: ProcessFatalEntry[] = [];
    const flush = mock(() => {});
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    (process as any).exit = exitSpy;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        flush,
        report: (entry) => entries.push(entry),
      });
      reporter.install();
      expect(target.listenerCount("uncaughtException")).toBe(1);

      target.listeners.get("uncaughtException")![0](new Error("boom"));

      expect(flush).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("boom");
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      (process as any).exit = originalExit;
    }
  });

  it("observes only when another uncaughtException listener is already installed", () => {
    const target = makeCountingTarget();
    target.on("uncaughtException", () => {}); // pre-existing host handler
    const entries: ProcessFatalEntry[] = [];
    const flush = mock(() => {});
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    (process as any).exit = exitSpy;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        flush,
        report: (entry) => entries.push(entry),
      });
      reporter.install();
      expect(target.listenerCount("uncaughtException")).toBe(2);

      target.listeners.get("uncaughtException")!.at(-1)!(new Error("boom"));

      expect(exitSpy).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("boom");
    } finally {
      (process as any).exit = originalExit;
    }
  });

  it("preserveUncaughtExit: false observes only even as sole owner", () => {
    const target = makeCountingTarget();
    const entries: ProcessFatalEntry[] = [];
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    (process as any).exit = exitSpy;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        preserveUncaughtExit: false,
        report: (entry) => entries.push(entry),
      });
      reporter.install();

      target.listeners.get("uncaughtException")![0](new Error("boom"));

      expect(exitSpy).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
    } finally {
      (process as any).exit = originalExit;
    }
  });

  it("does not exit when a capture callback owns uncaught-exception handling", () => {
    const target = makeCountingTarget();
    const entries: ProcessFatalEntry[] = [];
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    const originalCapture = (process as any).hasUncaughtExceptionCaptureCallback;
    (process as any).exit = exitSpy;
    (process as any).hasUncaughtExceptionCaptureCallback = () => true;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        report: (entry) => entries.push(entry),
      });
      reporter.install();

      target.listeners.get("uncaughtException")![0](new Error("boom"));

      expect(exitSpy).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
    } finally {
      (process as any).exit = originalExit;
      (process as any).hasUncaughtExceptionCaptureCallback = originalCapture;
    }
  });

  it("never exits on an unhandledRejection under the default policy", () => {
    const target = makeCountingTarget();
    const entries: ProcessFatalEntry[] = [];
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    (process as any).exit = exitSpy;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        report: (entry) => entries.push(entry),
      });
      reporter.install();
      expect(target.listenerCount("unhandledRejection")).toBe(1);

      target.listeners.get("unhandledRejection")![0]("rejected");

      expect(exitSpy).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("unhandledRejection");
    } finally {
      (process as any).exit = originalExit;
    }
  });

  it("exitOnUnhandledRejection: true opts into the exit", () => {
    const target = makeCountingTarget();
    const entries: ProcessFatalEntry[] = [];
    const exitSpy = mock(() => {});
    const originalExit = (process as any).exit;
    (process as any).exit = exitSpy;

    try {
      const reporter = new ProcessFatalReporter({
        target: target as any,
        exitOnUnhandledRejection: true,
        report: (entry) => entries.push(entry),
      });
      reporter.install();

      target.listeners.get("unhandledRejection")![0]("rejected");

      expect(entries).toHaveLength(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      (process as any).exit = originalExit;
    }
  });
});

/** Absolute file URL of the module under test, for the child-process script. */
const REPORTER_MODULE_URL = new URL("../../src/core/process-fatal-reporter.ts", import.meta.url).href;

/** Write a throwaway module that installs the reporter and then throws. */
function writeCrashModule(): { dir: string; module: string } {
  const dir = mkdtempSync(join(tmpdir(), "rolebox-fatal-"));
  const module = join(dir, "crash.ts");
  writeFileSync(
    module,
    [
      `import { ProcessFatalReporter } from ${JSON.stringify(REPORTER_MODULE_URL)};`,
      'new ProcessFatalReporter({ flush: () => {}, report: () => {} }).install();',
      'throw new Error("rolebox fatal e2e");',
      "",
    ].join("\n"),
  );
  return { dir, module };
}

/** Child environment: hermetic log file, stderr gate forced by the caller. */
function crashEnv(dir: string): Record<string, string | undefined> {
  return { ...process.env, ROLEBOX_LOG_FILE: join(dir, "rolebox.log") };
}

/**
 * End-to-end proof: the reporter is installed in a REAL child process which
 * then throws, so the assertion covers the runtime's actual crash path rather
 * than a stubbed process object.
 */
describe("ProcessFatalReporter — real crash in a child process", () => {
  it("exits 1 instead of swallowing the crash and prints the gated stderr line", () => {
    const { dir, module } = writeCrashModule();
    try {
      const child = Bun.spawnSync([process.execPath, module], {
        cwd: dir,
        env: { ...crashEnv(dir), ROLEBOX_FATAL_STDERR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain("[rolebox] uncaughtException: rolebox fatal e2e");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the default exit status with the stderr gate off", async () => {
    const { dir, module } = writeCrashModule();
    const env = crashEnv(dir);
    delete env.ROLEBOX_FATAL_STDERR;

    try {
      const child = Bun.spawn([process.execPath, module], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await Bun.readableStreamToText(child.stderr);
      const exitCode = await child.exited;

      expect(exitCode).toBe(1);
      expect(stderr).not.toContain("[rolebox]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

