import { describe, it, expect } from "bun:test";
import { lexer, marked } from "marked";
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

  it("renders the `## Available memory` heading", () => {
    const result = buildMemoryBlock([makeSummary()]);
    expect(result).toContain("## Available memory");
  });

  it("renders one table row per entry under the shared header", () => {
    const result = buildMemoryBlock([makeSummary()]);
    expect(result).toContain("| id | category | relevance | title | updated |");
    expect(result).toContain("| --- | --- | --- | --- | --- |");
    expect(result).toContain("| test-id | note | medium | Test Memory | 2026-07-04T10:00:00Z |");
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

    expect(result).toContain("| test-1 | note | high | Test Memory | 2026-07-04T10:00:00Z |");
  });

  it("does not include the memory body", () => {
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

  it("renders one row per entry for multiple memories", () => {
    const memories = [
      makeSummary({ id: "mem-1", title: "First", category: "note", relevance: "high" }),
      makeSummary({ id: "mem-2", title: "Second", category: "decision", relevance: "medium" }),
      makeSummary({ id: "mem-3", title: "Third", category: "bug", relevance: "low" }),
    ];
    const result = buildMemoryBlock(memories);

    expect(result).toContain("| mem-1 | note | high | First | 2026-07-04T10:00:00Z |");
    expect(result).toContain("| mem-2 | decision | medium | Second | 2026-07-04T10:00:00Z |");
    expect(result).toContain("| mem-3 | bug | low | Third | 2026-07-04T10:00:00Z |");

    // Count data rows — should be exactly 3
    const rows = result.match(/^\| mem-/gm);
    expect(rows).toHaveLength(3);
  });

  it("escapes a pipe in a cell so it cannot split the table row", () => {
    const result = buildMemoryBlock([
      makeSummary({ title: "Use | in a title" }),
    ]);
    expect(result).toContain(
      "| test-id | note | medium | Use \\| in a title | 2026-07-04T10:00:00Z |",
    );
  });

  it("escapes a backslash before a pipe so the row keeps its column count", () => {
    // One literal backslash followed by a pipe. Escaping the pipe alone leaves
    // the backslash bare, GFM reads `\\|` as an escaped backslash plus a REAL
    // delimiter, and the row shifts (title truncated, `updated` pushed out).
    const title = "a\\|b";
    const result = buildMemoryBlock([makeSummary({ title })]);
    const updated = "2026-07-04T10:00:00Z";

    const table = lexer(result).find((token) => token.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.header).toHaveLength(5);
    expect(table.rows[0]).toHaveLength(5);

    // The rendered row carries the full title in its own cell.
    const cells = [...marked.parse(result, { async: false }).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(["test-id", "note", "medium", title, updated]);
  });

  it("keeps special characters in a title as plain cell text", () => {
    const result = buildMemoryBlock([
      makeSummary({ title: 'Use "quotes" & <angles>' }),
    ]);
    expect(result).toContain(
      '| test-id | note | medium | Use "quotes" & <angles> | 2026-07-04T10:00:00Z |',
    );
  });

  it("handles empty values in optional-style fields gracefully", () => {
    const result = buildMemoryBlock([
      makeSummary({ category: "", relevance: "" }),
    ]);
    expect(result).toContain("| test-id |  |  | Test Memory | 2026-07-04T10:00:00Z |");
  });
});
