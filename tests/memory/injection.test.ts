import { describe, it, expect } from "bun:test";
import { buildMemoryBlock } from "../../src/prompt/builder.ts";
import type { MemorySummary } from "../../src/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<MemorySummary>): MemorySummary {
  return {
    id: "test-id",
    title: "Test Memory",
    category: "note",
    relevance: "medium",
    updated_at: "2026-07-04T10:00:00Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildMemoryBlock", () => {
  it("returns empty string for empty array", () => {
    expect(buildMemoryBlock([])).toBe("");
  });

  it("produces <available_memory> wrapper tag", () => {
    const result = buildMemoryBlock([makeSummary()]);
    expect(result).toContain("<available_memory>");
    expect(result).toContain("</available_memory>");
  });

  it("wraps each entry in <memory> tags", () => {
    const result = buildMemoryBlock([makeSummary()]);
    expect(result).toContain("<memory>");
    expect(result).toContain("</memory>");
  });

  it("includes id, title, category, relevance, and updated fields", () => {
    const result = buildMemoryBlock([
      makeSummary({
        id: "test-1",
        title: "Test Memory",
        category: "note",
        relevance: "high",
        updated_at: "2026-07-04T10:00:00Z",
      }),
    ]);

    expect(result).toContain("<id>test-1</id>");
    expect(result).toContain("<title>Test Memory</title>");
    expect(result).toContain("<category>note</category>");
    expect(result).toContain("<relevance>high</relevance>");
    expect(result).toContain("<updated>2026-07-04T10:00:00Z</updated>");
  });

  it("does not include a <content> tag", () => {
    const result = buildMemoryBlock([makeSummary()]);
    expect(result).not.toContain("<content>");
    expect(result).not.toContain("</content>");
  });

  it("includes the static instruction text about memory_recall", () => {
    const result = buildMemoryBlock([makeSummary()]);
    expect(result).toContain(
      "Memory entries from previous sessions. Use memory_recall to search for specific memories.",
    );
  });

  it("includes multiple <memory> children for multiple entries", () => {
    const memories = [
      makeSummary({ id: "mem-1", title: "First", category: "note", relevance: "high" }),
      makeSummary({ id: "mem-2", title: "Second", category: "decision", relevance: "medium" }),
      makeSummary({ id: "mem-3", title: "Third", category: "bug", relevance: "low" }),
    ];
    const result = buildMemoryBlock(memories);

    expect(result).toContain("<id>mem-1</id>");
    expect(result).toContain("<title>First</title>");
    expect(result).toContain("<id>mem-2</id>");
    expect(result).toContain("<title>Second</title>");
    expect(result).toContain("<id>mem-3</id>");
    expect(result).toContain("<title>Third</title>");
    expect(result).toContain("<category>decision</category>");
    expect(result).toContain("<category>bug</category>");
    expect(result).toContain("<relevance>low</relevance>");

    // Count <memory> open tags — should be exactly 3
    const memoryOpenTags = result.match(/<memory>/g);
    expect(memoryOpenTags).toHaveLength(3);

    const memoryCloseTags = result.match(/<\/memory>/g);
    expect(memoryCloseTags).toHaveLength(3);
  });

  it("escapes special XML characters in title", () => {
    const result = buildMemoryBlock([
      makeSummary({ title: 'Use "quotes" & <angles>' }),
    ]);
    expect(result).toContain(
      "<title>Use &quot;quotes&quot; &amp; &lt;angles&gt;</title>",
    );
  });

  it("handles empty values in optional-style fields gracefully", () => {
    const result = buildMemoryBlock([
      makeSummary({ category: "", relevance: "" }),
    ]);
    expect(result).toContain("<category></category>");
    expect(result).toContain("<relevance></relevance>");
  });
});
