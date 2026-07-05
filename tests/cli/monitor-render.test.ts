import { describe, it, expect } from "bun:test";
import { stripAnsi } from "../../src/cli/format";
import type {
  MonitorSnapshot,
} from "../../src/cli/commands/monitor-reader";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Intercept console.log calls during fn() and return them as an array.
 * Mirror of the pattern used in monitor.ts watch-mode line counting.
 */
function captureStdout(fn: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return logs;
}

/**
 * Build a minimal MonitorSnapshot with safe defaults.
 * Mirrors the helper in tests/cli/commands/monitor.test.ts.
 */
function makeMonitorSnapshot(
  overrides?: Partial<MonitorSnapshot>,
): MonitorSnapshot {
  return {
    projectDir: "/fake/project",
    timestamp: "2025-01-01T00:00:00.000Z",
    tasks: [],
    activeFunctions: [],
    loops: [],
    graphSessions: [],
    dispatchSummary: {
      pending: 0,
      running: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
    },
    concurrency: { active: 0, limit: 0, queued: 0 },
    ...overrides,
  };
}

async function importMonitor() {
  return await import("../../src/cli/commands/monitor");
}

// ── renderSystemPulse ────────────────────────────────────────

describe("renderSystemPulse", () => {
  it("renders ACTIVE health for running tasks with ANSI codes", async () => {
    const { renderSystemPulse } = await importMonitor();

    const lines = captureStdout(() => {
      renderSystemPulse(makeMonitorSnapshot({
        dispatchSummary: { pending: 0, running: 3, completed: 10, error: 0, cancelled: 0 },
        tasks: [
          { id: "t1", status: "running", agent: "a", startedAt: new Date(Date.now() - 2000).toISOString(), durationMs: 2000, depth: 0, mode: "background" },
        ],
      }));
    });

    const joined = lines.join("");
    // Should be wrapped in a panel (5+ lines: top border, content, bottom border)
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // ANSI codes present
    expect(joined).toContain("\x1b[");

    // Health state visible
    expect(joined).toContain("ACTIVE");

    // Running count visible
    expect(joined).toContain("3");
    expect(joined).toContain("running");

    // Completed count visible
    expect(joined).toContain("10");
  });

  it("renders IDLE health when no activity", async () => {
    const { renderSystemPulse } = await importMonitor();

    const lines = captureStdout(() => {
      renderSystemPulse(makeMonitorSnapshot());
    });

    const clean = stripAnsi(lines.join(""));
    expect(clean).toContain("IDLE");
  });

  it("renders ERROR health when tasks have errors", async () => {
    const { renderSystemPulse } = await importMonitor();

    const lines = captureStdout(() => {
      renderSystemPulse(makeMonitorSnapshot({
        dispatchSummary: { pending: 0, running: 0, completed: 0, error: 1, cancelled: 0 },
        tasks: [
          { id: "t1", status: "error", agent: "a", startedAt: new Date().toISOString(), durationMs: 500, depth: 0, mode: "background", error: "fail" },
        ],
      }));
    });

    const clean = stripAnsi(lines.join(""));
    expect(clean).toContain("ERROR");
    expect(clean).toContain("1");
    expect(clean).toContain("error");
  });

  it("suppresses zero-count items", async () => {
    const { renderSystemPulse } = await importMonitor();

    const lines = captureStdout(() => {
      renderSystemPulse(makeMonitorSnapshot({
        dispatchSummary: { pending: 0, running: 1, completed: 5, error: 0, cancelled: 0 },
        tasks: [
          { id: "t1", status: "running", agent: "a", startedAt: new Date().toISOString(), durationMs: 1000, depth: 0, mode: "background" },
        ],
      }));
    });

    const clean = stripAnsi(lines.join(""));
    // Running and completed should show
    expect(clean).toContain("1");
    expect(clean).toContain("5");
    // Zero items should be suppressed
    expect(clean).not.toContain("pending");
    expect(clean).not.toContain("error");
  });

  it("produces no ANSI code leakage after stripAnsi", async () => {
    const { renderSystemPulse } = await importMonitor();

    const lines = captureStdout(() => {
      renderSystemPulse(makeMonitorSnapshot({
        dispatchSummary: { pending: 2, running: 3, completed: 10, error: 1, cancelled: 0 },
        tasks: [
          { id: "t1", status: "running", agent: "a", startedAt: new Date().toISOString(), durationMs: 3000, depth: 0, mode: "background" },
        ],
      }));
    });

    const joined = lines.join("");
    const clean = stripAnsi(joined);
    expect(clean).not.toContain("\x1b");

    // Box-drawing visible
    expect(clean).toContain("┌");
    expect(clean).toContain("┐");
  });

  it("border lines are consistent widths", async () => {
    const { renderSystemPulse } = await importMonitor();

    const lines = captureStdout(() => {
      renderSystemPulse(makeMonitorSnapshot({
        dispatchSummary: { pending: 1, running: 1, completed: 5, error: 0, cancelled: 0 },
        tasks: [
          { id: "t1", status: "running", agent: "a", startedAt: new Date().toISOString(), durationMs: 1000, depth: 0, mode: "background" },
        ],
      }));
    });

    // At least 3 lines: top border, content, bottom border
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // All plain text widths should be within 2 chars of each other
    const topBorder = stripAnsi(lines[0]).length;
    const bottomBorder = stripAnsi(lines[lines.length - 1]).length;
    expect(Math.abs(topBorder - bottomBorder)).toBeLessThanOrEqual(2);
  });
});

// ── formatDuration ───────────────────────────────────────────

describe("formatDuration", () => {
  it("returns '0ms' for 0ms", async () => {
    const { formatDuration } = await importMonitor();
    expect(formatDuration(0)).toBe("0ms");
  });

  it("returns ms for sub-second values", async () => {
    const { formatDuration } = await importMonitor();
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("returns seconds for 1s-59s range", async () => {
    const { formatDuration } = await importMonitor();
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("returns minutes for exact minute values", async () => {
    const { formatDuration } = await importMonitor();
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(120000)).toBe("2m");
  });

  it("returns minutes and seconds for mixed values", async () => {
    const { formatDuration } = await importMonitor();
    expect(formatDuration(61000)).toBe("1m 1s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(3665000)).toBe("61m 5s");
  });
});

// ── truncate ─────────────────────────────────────────────────

describe("truncate", () => {
  it("returns original string when shorter than maxLen", async () => {
    const { truncate } = await importMonitor();
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns original string when equal to maxLen", async () => {
    const { truncate } = await importMonitor();
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and adds ellipsis when longer than maxLen", async () => {
    const { truncate } = await importMonitor();
    expect(truncate("hello world", 8)).toBe("hello w\u2026");
  });

  it("handles multibyte Chinese characters correctly", async () => {
    const { truncate } = await importMonitor();
    // JS .slice() on strings: "你好世界".length = 4
    expect(truncate("你好世界", 3)).toBe("你好\u2026");
    expect(truncate("你好世界", 4)).toBe("你好世界");
  });

  it("handles emoji characters", async () => {
    const { truncate } = await importMonitor();
    const emojiStr = "abc🔥def";
    // "abc🔥def".length = 7. slice(0, 5) = "abc🔥" (🔥 is 2 code units),
    // but with maxLen=6: slice(0, 5) + "…" = "abc🔥" + "…"
    expect(truncate(emojiStr, 6)).toBe("abc🔥\u2026");
  });
});
