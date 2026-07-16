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
    expect(result).toContain("ses_abc123de...");
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
});
