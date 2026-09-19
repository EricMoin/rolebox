import { describe, it, expect } from "bun:test";
import {
  relativeTime,
  formatDate,
  formatDuration,
  formatSessionTable,
  formatSessionListTable,
  formatMessages,
  formatStats,
  formatDiff,
  formatSearchResults,
  formatTodoList,
} from "../../src/session/formatters.ts";

/**
 * Body lines of the first file block, i.e. everything after its `+++ b/`
 * header. Returns `[]` when the file produced no block.
 */
function diffBody(result: string): string[] {
  const lines = result.split("\n");
  const header = lines.findIndex((line) => line.startsWith("+++ "));
  return header === -1 ? [] : lines.slice(header + 1);
}

describe("relativeTime", () => {
  const now = Date.now();

  it('returns "just now" for future timestamps', () => {
    expect(relativeTime(now + 100_000)).toBe("just now");
  });

  it("returns seconds for < 1 minute", () => {
    expect(relativeTime(now - 5_000)).toBe("5s ago");
    expect(relativeTime(now - 59_000)).toBe("59s ago");
  });

  it("returns minutes for < 1 hour", () => {
    expect(relativeTime(now - 60_000)).toBe("1m ago");
    expect(relativeTime(now - 3_540_000)).toBe("59m ago");
  });

  it("returns hours for < 1 day", () => {
    expect(relativeTime(now - 3_600_000)).toBe("1h ago");
    expect(relativeTime(now - 23 * 3_600_000)).toBe("23h ago");
  });

  it('returns "1 day ago" for exactly 1 day', () => {
    expect(relativeTime(now - 86_400_000)).toBe("1 day ago");
  });

  it("returns plural days for > 1 day", () => {
    expect(relativeTime(now - 2 * 86_400_000)).toBe("2 days ago");
    expect(relativeTime(now - 30 * 86_400_000)).toBe("30 days ago");
  });

  it("degrades non-finite input instead of rendering NaN", () => {
    expect(relativeTime(NaN)).toBe("unknown");
    expect(relativeTime(Infinity)).toBe("unknown");
    expect(relativeTime(-Infinity)).toBe("unknown");
  });
});

describe("formatDate", () => {
  it("formats a timestamp as ISO-like string without milliseconds", () => {
    // 2024-01-15T10:30:00.000Z
    const result = formatDate(1705314600000);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(result).toBe("2024-01-15 10:30:00");
  });

  it("handles epoch", () => {
    expect(formatDate(0)).toBe("1970-01-01 00:00:00");
  });

  it("never throws on non-finite or out-of-range timestamps", () => {
    expect(() => formatDate(NaN)).not.toThrow();
    expect(formatDate(NaN)).toBe("unknown");
    expect(formatDate(Infinity)).toBe("unknown");
    expect(formatDate(-Infinity)).toBe("unknown");
    expect(() => formatDate(8.7e15)).not.toThrow();
    expect(formatDate(8.7e15)).toBe("unknown");
  });

  it("renders negative epochs", () => {
    expect(formatDate(-1)).toBe("1969-12-31 23:59:59");
  });
});

describe("formatDuration", () => {
  it("returns 0s for negative ms", () => {
    expect(formatDuration(-1)).toBe("0s");
  });

  it("returns seconds for < 1 minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
  });

  it("returns minutes and seconds for < 1 hour", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("returns hours and minutes for >= 1 hour", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(7_200_000)).toBe("2h 0m");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(25 * 3_600_000)).toBe("25h 0m");
  });

  it("degrades non-finite durations instead of rendering NaN", () => {
    expect(formatDuration(NaN)).toBe("0s");
    expect(formatDuration(Infinity)).toBe("0s");
    expect(formatDuration(-Infinity)).toBe("0s");
  });
});

describe("formatSessionTable", () => {
  it('returns "No sessions found." for empty array', () => {
    expect(formatSessionTable([])).toBe("No sessions found.");
  });

  it("formats a single session row", () => {
    const result = formatSessionTable([
      {
        id: "ses_abc123def456",
        projectID: "proj1",
        directory: "/tmp",
        title: "Test Session",
        version: "1",
        time: { created: 1705314600000, updated: 1705318200000 },
      },
    ]);
    expect(result).toContain("| Session ID | Title | Date Range | Duration |");
    expect(result).toContain("ses_abc123def456");
    expect(result).not.toContain("ses_abc123de...");
    expect(result).toContain("Test Session");
    expect(result).toContain("2024-01-15");
    expect(result).toContain("1h 0m");
  });

  it("handles untitled sessions", () => {
    const result = formatSessionTable([
      {
        id: "ses_short",
        projectID: "proj1",
        directory: "/tmp",
        title: "",
        version: "1",
        time: { created: 0, updated: 0 },
      },
    ]);
    expect(result).toContain("(untitled)");
  });

  it("keeps a title containing a pipe and a newline inside one row", () => {
    const result = formatSessionTable([
      {
        id: "ses_row",
        projectID: "proj1",
        directory: "/tmp",
        title: "a|b\nc",
        version: "1",
        time: { created: 1705314600000, updated: 1705318200000 },
      },
    ]);
    const rows = result.split("\n");
    expect(rows.length).toBe(3); // header, separator, one data row
    expect(result).toContain("a\\|b<br>c");
    expect(rows[2].startsWith("| ses_row |")).toBe(true);
  });

  it("does not throw when a timestamp is missing or out of range", () => {
    const result = formatSessionTable([
      {
        id: "ses_bad",
        projectID: "proj1",
        directory: "/tmp",
        title: "Bad time",
        version: "1",
        time: { created: NaN, updated: Infinity },
      },
    ]);
    expect(result).toContain("ses_bad");
    expect(result).toContain("unknown -> unknown");
    expect(result).toContain("| 0s |");
  });
});

describe("formatSessionListTable", () => {
  it('returns "No sessions found." for empty array', () => {
    expect(formatSessionListTable([], {})).toBe("No sessions found.");
  });

  it("includes message count column", () => {
    const result = formatSessionListTable(
      [
        {
          id: "ses_1",
          projectID: "p1",
          directory: "/tmp",
          title: "Session A",
          version: "1",
          time: { created: 1705314600000, updated: 1705318200000 },
        },
      ],
      { ses_1: 5 },
    );
    expect(result).toContain("Messages");
    expect(result).toContain("5");
  });

  it("defaults missing message count to 0", () => {
    const result = formatSessionListTable(
      [
        {
          id: "ses_unknown",
          projectID: "p1",
          directory: "/tmp",
          title: "B",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      ],
      {},
    );
    expect(result).toContain("0");
  });

  it("emits the full session id in the ID column when longer than 12 chars", () => {
    const longId = "ses_abcdef1234567890";
    const result = formatSessionListTable(
      [
        {
          id: longId,
          projectID: "p1",
          directory: "/tmp",
          title: "Long ID",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      ],
      { [longId]: 1 },
    );
    expect(result).toContain(`| ${longId} |`);
    expect(result).not.toContain("...");
  });

  it("keeps a title containing a pipe and a newline inside one row", () => {
    const result = formatSessionListTable(
      [
        {
          id: "ses_row",
          projectID: "p1",
          directory: "/tmp",
          title: "a|b\nc",
          version: "1",
          time: { created: 1705314600000, updated: 1705318200000 },
        },
      ],
      { ses_row: 2 },
    );
    const rows = result.split("\n");
    expect(rows.length).toBe(3); // header, separator, one data row
    expect(result).toContain("a\\|b<br>c");
    expect(result).toContain("| 2 |");
  });
});

describe("formatMessages", () => {
  const baseMsg = (overrides: Record<string, unknown> = {}) => ({
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 1705314600000 },
      ...overrides,
    },
    parts: [],
  });

  it("returns empty string for empty messages", () => {
    expect(formatMessages([])).toBe("");
  });

  it("formats a user text message", () => {
    const result = formatMessages([
      {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "user" as const,
          time: { created: 1705314600000 },
        },
        parts: [
          { id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Hello" },
        ],
      },
    ]);
    expect(result).toContain("[Message 1] user");
    expect(result).toContain("2024-01-15 10:30:00");
    expect(result).toContain("Hello");
  });

  it("ignores text parts with ignored=true", () => {
    const result = formatMessages([
      {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "user" as const,
          time: { created: 1705314600000 },
        },
        parts: [
          { id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Secret", ignored: true },
        ],
      },
    ]);
    expect(result).not.toContain("Secret");
  });

  it("includes cost and model for assistant messages", () => {
    const result = formatMessages([
      {
        info: {
          id: "msg_2",
          sessionID: "ses_1",
          role: "assistant" as const,
          modelID: "gpt-4",
          providerID: "openai",
          cost: 0.002,
          time: { created: 1705314600000 },
        },
        parts: [
          { id: "p2", sessionID: "ses_1", messageID: "msg_2", type: "text", text: "Response" },
        ],
      },
    ]);
    expect(result).toContain("Model: openai/gpt-4");
    expect(result).toContain("Cost: $0.002000");
  });

  it("filters by role when roleFilter is set", () => {
    const result = formatMessages(
      [
        {
          info: { id: "m1", sessionID: "s1", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "User text" }],
        },
        {
          info: { id: "m2", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
          parts: [{ id: "p2", sessionID: "s1", messageID: "m2", type: "text", text: "Assistant text" }],
        },
      ],
      { roleFilter: "assistant" },
    );
    expect(result).not.toContain("User text");
    expect(result).toContain("Assistant text");
  });

  it("applies offset to message index display", () => {
    const result = formatMessages(
      [
        {
          info: { id: "m1", sessionID: "s1", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Hello" }],
        },
      ],
      { offset: 5 },
    );
    expect(result).toContain("[Message 6]");
  });

  it("includes thinking content when includeThinking is true", () => {
    const result = formatMessages(
      [
        {
          info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
          parts: [
            {
              id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning",
              text: "Deep thoughts", time: { start: 0 },
            },
          ],
        },
      ],
      { includeThinking: true },
    );
    expect(result).toContain("thinking:");
    expect(result).toContain("Deep thoughts");
  });

  it("excludes thinking content by default", () => {
    const result = formatMessages(
      [
        {
          info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
          parts: [
            {
              id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning",
              text: "Hidden", time: { start: 0 },
            },
          ],
        },
      ],
    );
    expect(result).not.toContain("thinking:");
    expect(result).not.toContain("Hidden");
  });

  it("truncates long text", () => {
    const long = "x".repeat(600);
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "user" as const, time: { created: 0 } },
        parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: long }],
      },
    ]);
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(long.length + 200);
  });

  it('shows tool calls with pending/running status', () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
        parts: [
          {
            id: "p1", sessionID: "s1", messageID: "m1", type: "tool", callID: "c1",
            tool: "bash", state: { status: "running" as const, input: {} },
          },
        ],
      },
    ]);
    expect(result).toContain("[tool: bash]");
    expect(result).toContain("running");
  });

  it('shows completed tool calls with title', () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
        parts: [
          {
            id: "p1", sessionID: "s1", messageID: "m1", type: "tool", callID: "c1",
            tool: "read", state: {
              status: "completed" as const, input: {}, output: "file content",
              title: "Read file", metadata: {},
              time: { start: 0, end: 100 },
            },
          },
        ],
      },
    ]);
    expect(result).toContain("[tool: read]");
    expect(result).toContain("Read file");
  });

  it('includes tool output when includeToolResults is set', () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
        parts: [
          {
            id: "p1", sessionID: "s1", messageID: "m1", type: "tool", callID: "c1",
            tool: "read", state: {
              status: "completed" as const, input: {}, output: "secret output",
              title: "Read", metadata: {}, time: { start: 0, end: 100 },
            },
          },
        ],
      },
    ], { includeToolResults: true });
    expect(result).toContain("output:");
    expect(result).toContain("secret output");
  });

  it('shows error tool calls', () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
        parts: [
          {
            id: "p1", sessionID: "s1", messageID: "m1", type: "tool", callID: "c1",
            tool: "bash", state: { status: "error" as const, error: "command not found", time: { start: 0, end: 100 } },
          },
        ],
      },
    ]);
    expect(result).toContain("ERROR:");
    expect(result).toContain("command not found");
  });

  it("filters by tool name", () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
        parts: [
          {
            id: "p1", sessionID: "s1", messageID: "m1", type: "tool", callID: "c1",
            tool: "bash", state: { status: "completed" as const, input: {}, output: "", title: "Run", metadata: {}, time: { start: 0, end: 100 } },
          },
          {
            id: "p2", sessionID: "s1", messageID: "m1", type: "tool", callID: "c2",
            tool: "read", state: { status: "completed" as const, input: {}, output: "", title: "Read", metadata: {}, time: { start: 0, end: 100 } },
          },
        ],
      },
    ], { toolFilter: "read" });
    expect(result).not.toContain("[tool: bash]");
    expect(result).toContain("[tool: read]");
  });

  it("skips unknown part types gracefully", () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "user" as const, time: { created: 0 } },
        parts: [
          { id: "p1", sessionID: "s1", messageID: "m1", type: "unknown", someField: "xyz" },
        ],
      },
    ]);
    // Should not throw; unknown types are silently skipped
    expect(result).toContain("[Message 1] user (1970-01-01 00:00:00)");
  });

  it("does not throw and renders a fallback date for an invalid timestamp", () => {
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "user" as const, time: { created: NaN } },
        parts: [],
      },
    ]);
    expect(result).toContain("[Message 1] user (unknown)");
  });

  it("does not render NaN for a non-finite cost", () => {
    const result = formatMessages([
      {
        info: {
          id: "m2", sessionID: "s1", role: "assistant" as const,
          modelID: "gpt-4", providerID: "openai", cost: NaN, time: { created: 0 },
        },
        parts: [],
      },
    ]);
    expect(result).toContain("Cost: $?");
    expect(result).not.toContain("NaN");
  });

  it("truncates without splitting a surrogate pair", () => {
    const text = `a${"\u{1F600}".repeat(400)}`;
    const result = formatMessages([
      {
        info: { id: "m1", sessionID: "s1", role: "user" as const, time: { created: 0 } },
        parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text }],
      },
    ]);
    expect(result).toContain("...");
    expect(result).not.toContain("\uFFFD");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    expect(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false);
  });
});

describe("formatStats", () => {
  const sampleStats = {
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalReasoningTokens: 200,
    totalCacheRead: 300,
    totalCacheWrite: 100,
    totalCost: 0.015,
    toolFrequencies: { read: 3, bash: 5 },
    modelDistribution: { "openai/gpt-4": 2 },
    totalAdditions: 50,
    totalDeletions: 10,
    filesModified: 3,
    diffs: [
      { file: "src/a.ts", before: "a", after: "b", additions: 10, deletions: 2 },
    ],
  };

  it("renders token section", () => {
    const result = formatStats(sampleStats);
    expect(result).toContain("### Token Usage");
    expect(result).toContain("Input:");
    expect(result).toContain("1,000");
    expect(result).toContain("Output:");
    expect(result).toContain("500");
  });

  it("renders cost", () => {
    const result = formatStats(sampleStats);
    expect(result).toContain("Total Cost: $0.015000");
  });

  it("renders model distribution sorted", () => {
    const result = formatStats(sampleStats);
    expect(result).toContain("### Models Used");
    expect(result).toContain("openai/gpt-4: 2 messages");
  });

  it("renders tool frequencies sorted by count desc", () => {
    const result = formatStats(sampleStats);
    expect(result).toContain("### Tool Usage");
    expect(result).toContain("bash: 5 calls");
    expect(result).toContain("read: 3 calls");
    // bash (5) should appear before read (3) sorted desc
    expect(result.indexOf("bash: 5")).toBeLessThan(result.indexOf("read: 3"));
  });

  it("renders file changes when diffs present", () => {
    const result = formatStats(sampleStats);
    expect(result).toContain("### File Changes");
    expect(result).toContain("Files modified: 3");
    expect(result).toContain("Additions: 50");
    expect(result).toContain("Deletions: 10");
  });

  it("omits models section when no distribution", () => {
    const noModels = { ...sampleStats, modelDistribution: {} };
    const result = formatStats(noModels);
    expect(result).not.toContain("### Models Used");
  });

  it("omits tools section when no frequencies", () => {
    const noTools = { ...sampleStats, toolFrequencies: {} };
    const result = formatStats(noTools);
    expect(result).not.toContain("### Tool Usage");
  });

  it("omits file changes section when no diffs", () => {
    const noDiffs = { ...sampleStats, diffs: [], filesModified: 0 };
    const result = formatStats(noDiffs);
    expect(result).not.toContain("### File Changes");
  });

  it("renders empty stats gracefully", () => {
    const empty = {
      totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
      totalCacheRead: 0, totalCacheWrite: 0, totalCost: 0,
      toolFrequencies: {}, modelDistribution: {},
      totalAdditions: 0, totalDeletions: 0, filesModified: 0, diffs: [],
    };
    const result = formatStats(empty);
    expect(result).toContain("Token Usage");
    expect(result).not.toContain("Models Used");
    expect(result).not.toContain("Tool Usage");
  });

  it("renders token counts with locale-independent separators", () => {
    const result = formatStats(sampleStats);
    // Deterministic grouping via formatCount, never toLocaleString.
    expect(result).toContain("1,000");
    expect(result).toContain("\n  Input:       1,000\n");
  });

  it("aligns the token label column", () => {
    const lines = formatStats(sampleStats).split("\n");
    expect(lines).toContain("  Input:       1,000");
    expect(lines).toContain("  Output:      500");
    expect(lines).toContain("  Reasoning:   200");
    expect(lines).toContain("  Cache read:  300");
    expect(lines).toContain("  Cache write: 100");
  });

  it("does not render NaN for a non-finite cost", () => {
    const result = formatStats({ ...sampleStats, totalCost: NaN });
    expect(result).toContain("Total Cost: $?");
    expect(result).not.toContain("NaN");
  });

  it("degrades non-finite counts instead of rendering NaN", () => {
    const result = formatStats({ ...sampleStats, totalInputTokens: NaN });
    expect(result).toContain("  Input:       ?");
    expect(result).not.toContain("NaN");
  });
});

describe("formatDiff", () => {
  it('returns "No file changes" for empty array', () => {
    expect(formatDiff([])).toBe("No file changes in this session.");
  });

  it("renders summary line", () => {
    const result = formatDiff([
      { file: "a.ts", before: "old", after: "new", additions: 5, deletions: 3 },
    ]);
    expect(result).toContain("Files changed: 1");
    expect(result).toContain("Additions: 5");
    expect(result).toContain("Deletions: 3");
  });

  it("renders per-file diff with +/- markers", () => {
    const result = formatDiff([
      { file: "src/index.ts", before: "hello\nworld", after: "hello\neveryone", additions: 1, deletions: 1 },
    ]);
    expect(result).toContain("--- a/src/index.ts");
    expect(result).toContain("+++ b/src/index.ts");
    expect(result).toContain("-world");
    expect(result).toContain("+everyone");
    expect(result).toContain(" hello");
  });

  it("handles added file (empty before)", () => {
    const result = formatDiff([
      { file: "new.ts", before: "", after: "content", additions: 1, deletions: 0 },
    ]);
    expect(result).toContain("+content");
  });

  it("handles deleted file (empty after)", () => {
    const result = formatDiff([
      { file: "gone.ts", before: "old", after: "", additions: 0, deletions: 1 },
    ]);
    expect(result).toContain("-old");
  });

  it("handles multiple diffs with separator", () => {
    const result = formatDiff([
      { file: "a.ts", before: "x", after: "y", additions: 1, deletions: 1 },
      { file: "b.ts", before: "a", after: "b", additions: 1, deletions: 1 },
    ]);
    const blocks = result.split("--- a/");
    expect(blocks.length >= 3).toBe(true); // summary + 2 file blocks
  });

  it("treats an inserted top line as one addition, not every line as changed", () => {
    const result = formatDiff([
      { file: "a.ts", before: "1\n2\n3", after: "0\n1\n2\n3", additions: 1, deletions: 0 },
    ]);
    const body = diffBody(result);
    expect(body).toContain("@@ -1,3 +1,4 @@");
    expect(body.filter((line) => line.startsWith("+"))).toEqual(["+0"]);
    expect(body.filter((line) => line.startsWith("-"))).toEqual([]);
    expect(body).toContain(" 1");
    expect(body).toContain(" 2");
    expect(body).toContain(" 3");
  });

  it("emits exactly one - and one + for a one-line change in a single hunk", () => {
    const result = formatDiff([
      { file: "a.ts", before: "1\n2\n3", after: "1\nX\n3", additions: 1, deletions: 1 },
    ]);
    const body = diffBody(result);
    expect(body.filter((line) => line.startsWith("@@"))).toEqual(["@@ -1,3 +1,3 @@"]);
    expect(body.filter((line) => line.startsWith("-"))).toEqual(["-2"]);
    expect(body.filter((line) => line.startsWith("+"))).toEqual(["+X"]);
  });

  it("skips a file block when the content is unchanged", () => {
    const result = formatDiff([
      { file: "same.ts", before: "a\nb\n", after: "a\nb\n", additions: 0, deletions: 0 },
    ]);
    expect(result).not.toContain("--- a/");
    expect(result).not.toContain("+++ b/");
    expect(result).toContain("Files changed: 1");
  });

  it("skips only the unchanged file and keeps the block separator", () => {
    const result = formatDiff([
      { file: "a.ts", before: "x", after: "y", additions: 1, deletions: 1 },
      { file: "same.ts", before: "a\n", after: "a\n", additions: 0, deletions: 0 },
      { file: "b.ts", before: "a", after: "b", additions: 1, deletions: 1 },
    ]);
    expect(result).not.toContain("--- a/same.ts");
    expect(result.split("--- a/").length).toBe(3); // summary + a.ts + b.ts
    expect(result).toContain("\n\n--- a/b.ts");
  });

  it("marks a side that does not end in a newline", () => {
    const result = formatDiff([
      { file: "a.ts", before: "a\nb", after: "a\nc", additions: 1, deletions: 1 },
    ]);
    const body = diffBody(result);
    expect(body).toContain("-b");
    expect(body).toContain("+c");
    expect(body.filter((line) => line === "\\ No newline at end of file").length).toBe(2);
  });

  it("does not emit a phantom trailing line for content ending in a newline", () => {
    const result = formatDiff([
      { file: "a.ts", before: "a\n", after: "a\nb\n", additions: 1, deletions: 0 },
    ]);
    const body = diffBody(result);
    expect(body).toContain("+b");
    expect(body.some((line) => line === "+")).toBe(false);
    expect(body).not.toContain("\\ No newline at end of file");
  });

  it("caps a large file body and reports the dropped line count", () => {
    const before = `${Array.from({ length: 500 }, (_, i) => `old-${i}`).join("\n")}\n`;
    const after = `${Array.from({ length: 500 }, (_, i) => `new-${i}`).join("\n")}\n`;
    const result = formatDiff([
      { file: "big.ts", before, after, additions: 500, deletions: 500 },
    ]);
    const body = diffBody(result);
    expect(body.length).toBe(401); // 400 body lines + the cap marker
    expect(body[400]).toBe("... (601 more lines)");
  });

  it("falls back to a bounded coarse diff past the matrix guard", () => {
    // 200_000 x 200_000 lines would need a 4e10-cell LCS table; the guard keeps
    // the shared prefix/suffix as context and presents the middle as one removed
    // block plus one added block.
    const before = [...Array(100_000).fill("A"), "P", "X", "Y", ...Array(99_997).fill("A")].join("\n");
    const after = [...Array(100_000).fill("A"), "Q", "X", "W", ...Array(99_997).fill("A")].join("\n");
    const result = formatDiff([
      { file: "huge.ts", before, after, additions: 2, deletions: 2 },
    ]);
    const body = diffBody(result);
    expect(body).toContain("-P");
    expect(body).toContain("-X");
    expect(body).toContain("+Q");
    expect(body).toContain("+X"); // an LCS diff would keep X as context, not re-add it
    expect(result.split("\n").length).toBeLessThan(30); // bounded, not 200k lines
  });
});

describe("formatSearchResults", () => {
  it('returns "No matches found." for empty matches', () => {
    expect(formatSearchResults([], 0, 0)).toBe("No matches found.");
  });

  it("renders match count header", () => {
    const result = formatSearchResults(
      [
        {
          sessionID: "ses_1", sessionTitle: "S1",
          messageID: "msg_1", role: "user",
          text: "search term", contextBefore: "", contextAfter: "",
        },
      ],
      1, 1,
    );
    expect(result).toContain("Found 1 match across 1 session");
  });

  it("pluralizes correctly", () => {
    const result = formatSearchResults(
      [
        {
          sessionID: "ses_1", sessionTitle: "S1",
          messageID: "msg_1", role: "user",
          text: "foo", contextBefore: "before ", contextAfter: " after",
        },
        {
          sessionID: "ses_2", sessionTitle: "S2",
          messageID: "msg_2", role: "assistant",
          text: "bar", contextBefore: "", contextAfter: "",
        },
      ],
      5, 2,
    );
    expect(result).toContain("Found 5 matches across 2 sessions");
  });

  it("emits full sessionID and messageID when longer than 12 chars", () => {
    const sessionID = "ses_abcdef1234567890";
    const messageID = "msg_abcdef1234567890";
    const result = formatSearchResults(
      [
        {
          sessionID, sessionTitle: "S1",
          messageID, role: "user",
          text: "term", contextBefore: "", contextAfter: "",
        },
      ],
      1, 1,
    );
    expect(result).toContain(`Session: ${sessionID} `);
    expect(result).toContain(`Message: ${messageID} |`);
    expect(result).not.toContain(`${sessionID.slice(0, 12)}...`);
    expect(result).not.toContain(`${messageID.slice(0, 12)}...`);
  });

  it("renders context with bold match", () => {
    const result = formatSearchResults(
      [
        {
          sessionID: "ses_1", sessionTitle: "S1",
          messageID: "msg_1", role: "user",
          text: "hello", contextBefore: "say ", contextAfter: " world",
        },
      ],
      1, 1,
    );
    expect(result).toContain("**hello**");
    expect(result).toContain("say ");
    expect(result).toContain(" world");
  });

  it("shows truncated footer when > 20 matches", () => {
    const manyMatches = Array.from({ length: 25 }, (_, i) => ({
      sessionID: `ses_${i}`, sessionTitle: `S${i}`,
      messageID: `msg_${i}`, role: "user" as const,
      text: "term", contextBefore: "", contextAfter: "",
    }));
    const result = formatSearchResults(manyMatches, 25, 25);
    expect(result).toContain("more matches");
  });

  it("collapses newlines so one match cannot inject extra lines", () => {
    const result = formatSearchResults(
      [
        {
          sessionID: "ses_1", sessionTitle: "S|1\nX",
          messageID: "msg_1", role: "user",
          text: "a\nb", contextBefore: "p\nq", contextAfter: "r\ns",
        },
      ],
      1, 1,
    );
    expect(result).toContain("**a b**");
    expect(result).toContain("(S|1 X)");
    expect(result).toContain("...p q");
    expect(result).toContain("r s...");
    // header (4 lines) + one 3-line match block; no injected rows.
    expect(result.split("\n").length).toBe(6);
  });
});

describe("formatTodoList", () => {
  it('returns "No todos" for empty array', () => {
    expect(formatTodoList([])).toBe("  No todos for this session.");
  });

  it("renders header with completion count", () => {
    const result = formatTodoList([
      { content: "Task A", status: "completed", priority: "high", id: "1" },
      { content: "Task B", status: "pending", priority: "low", id: "2" },
    ]);
    expect(result).toContain("1/2 completed");
  });

  it("renders [x] for completed, [~] for in_progress, [ ] for others", () => {
    const result = formatTodoList([
      { content: "Done", status: "completed", priority: "high", id: "1" },
      { content: "Doing", status: "in_progress", priority: "medium", id: "2" },
      { content: "Todo", status: "pending", priority: "low", id: "3" },
    ]);
    expect(result).toContain("[x] [high] Done");
    expect(result).toContain("[~] [medium] Doing");
    expect(result).toContain("[ ] [low] Todo");
  });

  it("collapses newlines so one todo cannot inject extra lines", () => {
    const result = formatTodoList([
      { content: "Do\nthis", status: "pending", priority: "low", id: "1" },
      { content: "Done", status: "completed", priority: "high", id: "2" },
    ]);
    expect(result.split("\n").length).toBe(3);
    expect(result).toContain("  [ ] [low] Do this");
  });
});
