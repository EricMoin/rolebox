import { describe, it, expect, mock } from "bun:test";
import {
  shortId,
  getDirectory,
  searchTexts,
  extractContext,
  collectSessionAnalytics,
} from "../../src/session/tool-helpers.ts";
import type { SessionClientWrapper } from "../../src/session/client.ts";
import { createMockClient } from "../dispatch/helpers.ts";
import type { SessionInfo, Message } from "../../src/session/types.ts";

/** Wrapper to cast ISessionClient mock to the SessionClientWrapper type expected by helpers. */
function mockClientWrapper(overrides?: Parameters<typeof createMockClient>[0]): SessionClientWrapper {
  return createMockClient(overrides) as unknown as SessionClientWrapper;
}

describe("shortId", () => {
  it("returns id as-is if ≤ 12 chars", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("123456789012")).toBe("123456789012");
  });

  it("truncates and appends ... if > 12 chars", () => {
    expect(shortId("1234567890123")).toBe("123456789012...");
    expect(shortId("abcdefghijklmnop")).toBe("abcdefghijkl...");
  });
});

describe("getDirectory", () => {
  it("returns the directory from context", () => {
    expect(getDirectory({ directory: "/tmp/test" })).toBe("/tmp/test");
  });

  it("returns undefined when directory is missing", () => {
    expect(getDirectory({})).toBeUndefined();
  });

  it("returns undefined when directory is empty string", () => {
    expect(getDirectory({ directory: "" })).toBeUndefined();
  });

  it("handles nullish directory gracefully", () => {
    expect(getDirectory({ directory: undefined as unknown as string })).toBeUndefined();
  });
});

describe("searchTexts", () => {
  it("finds matching text case-insensitively by default", () => {
    expect(searchTexts(["Hello World"], "world", false)).toBe(true);
    expect(searchTexts(["Hello World"], "hello", false)).toBe(true);
  });

  it("finds matching text case-sensitively when set", () => {
    expect(searchTexts(["Hello World"], "Hello", true)).toBe(true);
    expect(searchTexts(["Hello World"], "hello", true)).toBe(false);
  });

  it("returns false when no match", () => {
    expect(searchTexts(["Hello World"], "xyz", false)).toBe(false);
  });

  it("searches across multiple texts", () => {
    expect(searchTexts(["first text", "second text"], "second", false)).toBe(true);
    expect(searchTexts(["first", "second"], "third", false)).toBe(false);
  });

  it("handles empty texts array", () => {
    expect(searchTexts([], "anything", false)).toBe(false);
  });

  it("handles empty query string", () => {
    expect(searchTexts(["text"], "", false)).toBe(true);  // "" is found in every string
  });
});

describe("extractContext", () => {
  it("extracts match with surrounding context", () => {
    const result = extractContext(
      "The quick brown fox jumps over the lazy dog",
      "fox",
      false,
    );
    expect(result.match).toBe("fox");
    expect(result.before).toContain("brown ");
    expect(result.after).toContain(" jumps");
  });

  it("returns empty strings when query not found", () => {
    const result = extractContext("Hello world", "xyz", false);
    expect(result).toEqual({ before: "", match: "", after: "" });
  });

  it("trims before context with ellipsis when exceeds window/2", () => {
    const text = "A".repeat(200) + " needle " + "B".repeat(200);
    const result = extractContext(text, "needle", false, 80);
    expect(result.before).toContain("...");
    expect(result.match).toBe("needle");
  });

  it("trims after context with ellipsis when exceeds window/2", () => {
    const text = "A".repeat(50) + " needle " + "B".repeat(200);
    const result = extractContext(text, "needle", false, 80);
    expect(result.after).toContain("...");
  });

  it("respects case sensitivity", () => {
    const result1 = extractContext("Hello World", "world", false);
    expect(result1.match).toBe("World");

    const result2 = extractContext("Hello World", "world", true);
    expect(result2.match).toBe("");
  });

  it("extracts exact match text (preserving original case)", () => {
    const result = extractContext("Foo Bar Baz", "Bar", false);
    expect(result.match).toBe("Bar");
  });

  it("handles short text where window exceeds boundaries", () => {
    const result = extractContext("a b c", "b", false, 80);
    expect(result.match).toBe("b");
    expect(result.before).toBe("a ");
    expect(result.after).toBe(" c");
  });
});

describe("collectSessionAnalytics", () => {
  const sampleSession: SessionInfo = {
    id: "ses_test",
    projectID: "proj1",
    directory: "/tmp",
    title: "Test",
    version: "1",
    time: { created: 1000, updated: 2000 },
  };

  it("collects analytics from a session", async () => {
    const client = mockClientWrapper({
      sessionMessages: () => Promise.resolve([
        {
          info: {
            id: "msg_1", sessionID: "ses_test", role: "assistant" as const,
            modelID: "gpt-4", providerID: "openai", cost: 0.002,
            tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
            time: { created: 1000 },
          },
          parts: [
            { id: "p1", sessionID: "ses_test", messageID: "msg_1", type: "tool", callID: "c1", tool: "bash", state: { status: "completed" as const, input: {}, output: "", title: "Run", metadata: {}, time: { start: 1000, end: 1500 } } },
          ],
        },
      ]),
      sessionChildren: () => Promise.resolve([]),
      sessionTodo: () => Promise.resolve([
        { content: "Task A", status: "completed", priority: "high", id: "1" },
      ]),
      sessionStatus: () => Promise.resolve(null),
    });

    const analytics = await collectSessionAnalytics(client, sampleSession, "/tmp");
    expect(analytics.messageCount).toBe(1);
    expect(analytics.childrenCount).toBe(0);
    expect(analytics.status).toBe("unknown");
    expect(analytics.stats.totalInputTokens).toBe(100);
    expect(analytics.stats.totalOutputTokens).toBe(50);
    expect(analytics.stats.totalCost).toBe(0.002);
    expect(analytics.stats.toolFrequencies).toEqual({ bash: 1 });
    expect(analytics.stats.modelDistribution).toEqual({ "openai/gpt-4": 1 });
    expect(analytics.todos).toHaveLength(1);
  });

  it("handles sessions with no messages", async () => {
    const client = mockClientWrapper({
      sessionMessages: () => Promise.resolve([]),
      sessionChildren: () => Promise.resolve([]),
      sessionTodo: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve(null),
    });

    const analytics = await collectSessionAnalytics(client, sampleSession, "/tmp");
    expect(analytics.messageCount).toBe(0);
    expect(analytics.stats.totalInputTokens).toBe(0);
    expect(analytics.stats.modelDistribution).toEqual({});
    expect(analytics.todos).toHaveLength(0);
  });

  it("aggregates diffs into stats", async () => {
    const client = mockClientWrapper({
      sessionMessages: () => Promise.resolve([]),
      sessionChildren: () => Promise.resolve([]),
      sessionTodo: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve(null),
    });

    const sessionWithDiffs: SessionInfo = {
      ...sampleSession,
      summary: { additions: 10, deletions: 5, files: 2 },
    };

    const analytics = await collectSessionAnalytics(client, sessionWithDiffs, "/tmp");
    expect(analytics.stats.filesModified).toBe(0); // No diffs returned by mock
  });

  it("counts children correctly", async () => {
    const client = mockClientWrapper({
      sessionMessages: () => Promise.resolve([]),
      sessionChildren: () => Promise.resolve([
        { id: "child_1", projectID: "p1", directory: "/tmp", title: "Child", version: "1", time: { created: 1000, updated: 2000 } },
      ]),
      sessionTodo: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve(null),
    });

    const analytics = await collectSessionAnalytics(client, sampleSession, "/tmp");
    expect(analytics.childrenCount).toBe(1);
  });
});
