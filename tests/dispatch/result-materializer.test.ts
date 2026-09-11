import { describe, it, expect } from "bun:test";
import {
  buildAssistantText,
  extractFinalAssistantText,
} from "../../src/dispatch/completion/result-materializer.ts";
import { extractResultBlock } from "../../src/dispatch/completion/result-extractor.ts";
import type { SessionMessageSnapshot } from "../../src/dispatch/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

let idCounter = 0;

function assistant(
  parts: Array<{ type: string; text?: string }>,
): SessionMessageSnapshot {
  return { info: { role: "assistant", id: `a-${idCounter++}` }, parts };
}

function user(text: string): SessionMessageSnapshot {
  return {
    info: { role: "user", id: `u-${idCounter++}` },
    parts: [{ type: "text", text }],
  };
}

// ── buildAssistantText / extractFinalAssistantText ───────────────────

describe("buildAssistantText", () => {
  it("returns only the final assistant answer, ignoring tool-result echo text", () => {
    // First assistant message carries the Pi adapter's misclassified tool
    // echo (skill prompt + directory listing); last carries the real answer.
    const messages = [
      assistant([
        { type: "text", text: "# skill: gate-report\n--- SKILL.md content ---\nsrc/\n  file1.ts\n  file2.ts\n" },
      ]),
      assistant([{ type: "text", text: "gate report: PASS — all checks green" }]),
    ];

    expect(buildAssistantText(messages, 0)).toBe(
      "gate report: PASS — all checks green",
    );
  });

  it("ignores assistant messages whose parts are only tool/reasoning content", () => {
    const messages = [
      assistant([
        { type: "tool" },
        { type: "reasoning", text: "thinking through the gate..." },
      ]),
      assistant([{ type: "text", text: "the real answer" }]),
    ];

    expect(buildAssistantText(messages, 0)).toBe("the real answer");
  });

  it("respects the messageCountAtStart boundary", () => {
    const messages = [
      user("run the gate"),
      assistant([{ type: "text", text: "old answer" }]),
      assistant([{ type: "text", text: "new answer" }]),
    ];

    // Boundary points past the old answer — only the new one is in scope.
    expect(buildAssistantText(messages, 2)).toBe("new answer");

    // Boundary at the second message also excludes the first answer.
    expect(buildAssistantText(messages, 1)).toBe("new answer");
  });

  it("joins all text parts of the final assistant message", () => {
    const messages = [
      assistant([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    ];

    expect(buildAssistantText(messages, 0)).toBe("ab");
  });

  it("preserves ```result fence extraction on the final message", () => {
    const messages = [
      assistant([{ type: "text", text: "work in progress" }]),
      assistant([
        { type: "text", text: "final report:\n```result\nanswer: 42\n```" },
      ]),
    ];

    const fullText = buildAssistantText(messages, 0);
    expect(fullText).toBe("final report:\n```result\nanswer: 42\n```");

    const { result, hadFence } = extractResultBlock(fullText);
    expect(hadFence).toBe(true);
    expect(result).toBe("answer: 42");
  });

  it("falls back to '' for an empty transcript", () => {
    expect(buildAssistantText([], 0)).toBe("");
  });

  it("falls back to '' when no assistant text exists at all", () => {
    const messages = [
      user("hello"),
      assistant([{ type: "tool" }]),
      assistant([{ type: "reasoning", text: "no visible answer" }]),
    ];

    expect(buildAssistantText(messages, 0)).toBe("");
  });

  it("returns '' when the boundary is past the end of the messages", () => {
    const messages = [assistant([{ type: "text", text: "answer" }])];

    expect(buildAssistantText(messages, 5)).toBe("");
  });
});

describe("extractFinalAssistantText", () => {
  it("returns null when no assistant text exists", () => {
    expect(extractFinalAssistantText([], 0)).toBeNull();

    const toolOnly = [assistant([{ type: "tool" }])];
    expect(extractFinalAssistantText(toolOnly, 0)).toBeNull();
  });

  it("returns the last assistant text from the boundary forward", () => {
    const messages = [
      assistant([{ type: "text", text: "first" }]),
      assistant([{ type: "text", text: "second" }]),
    ];

    expect(extractFinalAssistantText(messages, 0)).toBe("second");
    expect(extractFinalAssistantText(messages, 1)).toBe("second");
  });
});
