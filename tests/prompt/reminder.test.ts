import { describe, it, expect } from "bun:test";
import { buildReminder, type BuildReminderOpts } from "../../src/prompt/reminder.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function build(opts: BuildReminderOpts): string {
  return buildReminder(opts);
}

/** Assert that `actual` has no consecutive spaces on any data line. */
function assertNoDoubleSpacesInData(actual: string): void {
  const lines = actual.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Skip the wrapper lines and blank lines
    if (
      lines[i] === "<system-reminder>" ||
      lines[i] === "</system-reminder>" ||
      lines[i].trim() === ""
    ) {
      continue;
    }
    // Only check data lines (key: value or marker), not action lines (which
    // inherently have "→ " as prefix) or body content (free form).
    if (lines[i].startsWith("→ ")) continue;
    // Skip lines that appear inside body blocks (free form text)
    expect(lines[i]).not.toMatch(
      / {2,}/,
      `line ${i + 1} has consecutive spaces: "${lines[i]}"`,
    );
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("buildReminder", () => {
  // ── Marker-only ───────────────────────────────────────────────────────

  it("produces marker-only output", () => {
    const result = build({ marker: "[GRAPH NODE COMPLETED]" });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[GRAPH NODE COMPLETED]",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("preserves marker verbatim (no case/whitespace normalization)", () => {
    const marker = "[Graph_Node_COMPLETED!]";
    const result = build({ marker });
    expect(result).toContain(marker);
  });

  // ── Marker + fields ───────────────────────────────────────────────────

  it("renders fields as key: value", () => {
    const result = build({
      marker: "[GRAPH NODE COMPLETED]",
      fields: [
        { label: "Graph", value: "g1" },
        { label: "Node", value: "n1" },
      ],
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[GRAPH NODE COMPLETED]",
        "Graph: g1",
        "Node: n1",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("omits fields with empty string value", () => {
    const result = build({
      marker: "[TEST]",
      fields: [
        { label: "A", value: "1" },
        { label: "B", value: "" },
        { label: "C", value: "3" },
      ],
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[TEST]",
        "A: 1",
        "C: 3",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("omits fields with undefined value (cast)", () => {
    const result = build({
      marker: "[TEST]",
      fields: [
        { label: "A", value: "1" },
        { label: "B", value: undefined as unknown as string },
        { label: "C", value: "3" },
      ],
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[TEST]",
        "A: 1",
        "C: 3",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("does NOT print N/A or any placeholder for missing values", () => {
    const result = build({
      marker: "[TEST]",
      fields: [
        { label: "A", value: "" },
      ],
    });
    expect(result).not.toContain("N/A");
    expect(result).not.toContain("n/a");
    expect(result).not.toContain("null");
    expect(result).not.toContain("undefined");
  });

  // ── Inline fields ─────────────────────────────────────────────────────

  it("joins inline fields with single space", () => {
    const result = build({
      marker: "[INLINE TEST]",
      fields: [
        { label: "A", value: "1", inline: true },
        { label: "B", value: "2", inline: true },
        { label: "C", value: "3", inline: true },
      ],
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[INLINE TEST]",
        "A: 1 B: 2 C: 3",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("mixes inline and non-inline fields", () => {
    const result = build({
      marker: "[MIXED]",
      fields: [
        { label: "Graph", value: "g1" },           // non-inline
        { label: "Node", value: "n1", inline: true }, // inlined onto Graph line
        { label: "Status", value: "done", inline: true },
        { label: "Phase", value: "COMPLETE" },      // non-inline → new line
      ],
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[MIXED]",
        "Graph: g1 Node: n1 Status: done",
        "Phase: COMPLETE",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  // ── Action ────────────────────────────────────────────────────────────

  it("adds action with blank line separator and → prefix", () => {
    const result = build({
      marker: "[GRAPH NODE COMPLETED]",
      fields: [
        { label: "Graph", value: "g1" },
        { label: "Node", value: "n1" },
      ],
      action: "Use graph_status to inspect the result.",
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[GRAPH NODE COMPLETED]",
        "Graph: g1",
        "Node: n1",
        "",
        "→ Use graph_status to inspect the result.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("renders multiple action lines each with → prefix", () => {
    const result = build({
      marker: "[GRAPH BLOCKED]",
      fields: [{ label: "Graph", value: "g1" }],
      action: "Inspect blocked nodes via graph_status.\nApprove or reject each blocked node.",
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[GRAPH BLOCKED]",
        "Graph: g1",
        "",
        "→ Inspect blocked nodes via graph_status.",
        "→ Approve or reject each blocked node.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("omits action when empty string", () => {
    const result = build({
      marker: "[NO-ACTION]",
      fields: [{ label: "A", value: "1" }],
      action: "",
    });
    expect(result).not.toContain("→");
  });

  it("action-only (no fields, no body)", () => {
    const result = build({
      marker: "[DO SOMETHING]",
      action: "Read the docs.",
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[DO SOMETHING]",
        "",
        "→ Read the docs.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  // ── Body ──────────────────────────────────────────────────────────────

  it("embeds body as free text after a blank line", () => {
    const result = build({
      marker: "[APPROVAL REQUIRED]",
      body: "Please review the following result.\nIt contains modifications to 3 files.",
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[APPROVAL REQUIRED]",
        "",
        "Please review the following result.",
        "It contains modifications to 3 files.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("embeds body alongside fields and action", () => {
    const result = build({
      marker: "[BLOCKED: NEEDS APPROVAL]",
      fields: [{ label: "Node", value: "approval-gate" }],
      action: "Use graph_approve to proceed.",
      body: "The worker produced 3 file modifications.\nAll tests pass.",
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[BLOCKED: NEEDS APPROVAL]",
        "Node: approval-gate",
        "",
        "→ Use graph_approve to proceed.",
        "",
        "The worker produced 3 file modifications.",
        "All tests pass.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("omits body when empty string", () => {
    const result = build({
      marker: "[TEST]",
      body: "",
    });
    expect(result).not.toContain("body");
  });

  // ── Combination: fields + body (no action) ────────────────────────────

  it("fields + body without action", () => {
    const result = build({
      marker: "[INFO]",
      fields: [{ label: "Source", value: "engine" }],
      body: "All systems operational.",
    });
    expect(result).toBe(
      [
        "<system-reminder>",
        "[INFO]",
        "Source: engine",
        "",
        "All systems operational.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  // ── No-consecutive-spaces guard ───────────────────────────────────────

  it("has no consecutive spaces on any data line", () => {
    const result = build({
      marker: "[CHECK SPACING]",
      fields: [
        { label: "Graph", value: "g1" },
        { label: "Node", value: "n1" },
        { label: "Agent", value: "worker-1", inline: true },
        { label: "Status", value: "done", inline: true },
      ],
    });
    assertNoDoubleSpacesInData(result);
  });

  it("has no consecutive spaces with mixed inline/non-inline", () => {
    const result = build({
      marker: "[MIXED SPACING]",
      fields: [
        { label: "A", value: "1" },
        { label: "B", value: "2", inline: true },
        { label: "C", value: "3", inline: true },
        { label: "D", value: "4" },
      ],
    });
    assertNoDoubleSpacesInData(result);
  });

  // ── Structural invariants ─────────────────────────────────────────────

  it("starts with <system-reminder> and ends with </system-reminder>", () => {
    const result = build({ marker: "[X]" });
    const lines = result.split("\n");
    expect(lines[0]).toBe("<system-reminder>");
    expect(lines[lines.length - 1]).toBe("</system-reminder>");
  });

  it("marker (when present) is on line 2 (immediately after opening tag)", () => {
    const result = build({ marker: "[ABC]" });
    const lines = result.split("\n");
    expect(lines[1]).toBe("[ABC]");
  });

  it("omits marker line when marker is undefined", () => {
    const result = build({
      fields: [{ label: "A", value: "1" }],
    });
    const lines = result.split("\n");
    expect(lines[0]).toBe("<system-reminder>");
    expect(lines[1]).toBe("A: 1"); // fields start immediately after opening tag
    expect(lines).not.toContain(""); // no blank line where marker would have been
  });

  it("omits marker line when marker is empty string", () => {
    const result = build({
      marker: "",
      fields: [{ label: "A", value: "1" }],
      action: "Do something.",
    });
    const lines = result.split("\n");
    expect(lines[0]).toBe("<system-reminder>");
    expect(lines[1]).toBe("A: 1");
  });

  // ── Compact mode ──────────────────────────────────────────────────────

  it("compact mode produces single-line output", () => {
    const result = build({
      marker: "[TEST]",
      fields: [
        { label: "A", value: "1" },
        { label: "B", value: "2" },
      ],
      action: "Do something.",
      compact: true,
    });
    const lines = result.split("\n");
    expect(lines.length).toBe(1);
    expect(result).toBe(
      "<system-reminder>[TEST] A: 1 B: 2 → Do something.</system-reminder>",
    );
  });

  it("compact mode without marker (no leading bracket)", () => {
    const result = build({
      fields: [{ label: "fn", value: "plan" }],
      action: "Activate these first.",
      compact: true,
    });
    expect(result).toBe(
      "<system-reminder>fn: plan → Activate these first.</system-reminder>",
    );
  });

  it("compact mode with marker, fields, action and body", () => {
    const result = build({
      marker: "[WARN]",
      fields: [{ label: "A", value: "1" }],
      action: "Check logs.",
      body: "More details here.",
      compact: true,
    });
    expect(result).toBe(
      "<system-reminder>[WARN] A: 1 → Check logs. More details here.</system-reminder>",
    );
  });

  it("marker spans exactly one line", () => {
    const marker = "[GRAPH COMPLETE]";
    const result = build({ marker });
    const count = result.split("\n").filter((l) => l === marker).length;
    expect(count).toBe(1);
  });

  it("uses plain key: value, never markdown bold", () => {
    const result = build({
      marker: "[TEST]",
      fields: [
        { label: "Graph", value: "g1" },
        { label: "Status", value: "complete" },
      ],
    });
    // The old style used **Key:** value — verify no bold markers in field lines.
    const dataLines = result
      .split("\n")
      .filter((l) => l.includes(":") && !l.startsWith("<") && !l.startsWith("→"));
    for (const line of dataLines) {
      expect(line).not.toContain("**");
    }
  });
});
