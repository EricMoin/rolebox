import { describe, it, expect, afterAll, vi } from "vitest";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { Message, Part, ToolPart } from "../src/session/types.ts";

const prevTimeout = process.env.ROLEBOX_CLIENT_TIMEOUT_MS;
process.env.ROLEBOX_CLIENT_TIMEOUT_MS = "80";

const { assembleTranscript } = await import("../src/copilot/transcript.ts");

afterAll(() => {
  if (prevTimeout !== undefined) {
    process.env.ROLEBOX_CLIENT_TIMEOUT_MS = prevTimeout;
  } else {
    delete process.env.ROLEBOX_CLIENT_TIMEOUT_MS;
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function msg(
  role: "user" | "assistant",
  parts: Part[],
  id = `m${Math.random()}`,
): Message {
  return {
    info: { id, sessionID: "sess-1", role, time: { created: 0 } },
    parts,
  };
}

function textPart(text: string): Part {
  return { id: "p", sessionID: "sess-1", messageID: "m", type: "text", text };
}

function toolPart(tool: string, state: ToolPart["state"]): Part {
  return {
    id: "p",
    sessionID: "sess-1",
    messageID: "m",
    type: "tool",
    callID: "call-1",
    tool,
    state,
  };
}

function clientWith(handler: (sid: string, opts?: { limit?: number }) => Promise<Message[] | null>) {
  return { messages: vi.fn(handler) } as unknown as ISessionClient;
}

const opts = (overrides: Partial<{ window_size: number; max_chars: number; include_tools: boolean }> = {}) => ({
  window_size: 10,
  max_chars: 10_000,
  include_tools: false,
  ...overrides,
});

// ── assembleTranscript ──────────────────────────────────────────────────────

describe("assembleTranscript", () => {
  it("windows the complete conversation locally and keeps the initial user goal", async () => {
    const messages = [
      msg("user", [textPart("m1")], "id-1"),
      msg("assistant", [textPart("m2")], "id-2"),
      msg("user", [textPart("m3")], "id-3"),
      msg("assistant", [textPart("m4")], "id-4"),
      msg("user", [textPart("m5")], "id-5"),
    ];
    const client = clientWith(async (sid, o) => {
      // DSH's limit selects the earliest messages, not the most recent ones.
      return o?.limit ? messages.slice(0, o.limit) : messages;
    });

    const result = await assembleTranscript(client, "sess-1", opts({ window_size: 3 }));

    expect(client.messages).toHaveBeenCalledWith("sess-1");
    expect(result).toBe("user: m1\nuser: m3\nassistant: m4\nuser: m5");
  });

  it("labels lines by role as user:/assistant:", async () => {
    const client = clientWith(async () => [
      msg("user", [textPart("hello")]),
      msg("assistant", [textPart("hi there")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts());

    expect(result).toBe("user: hello\nassistant: hi there");
  });

  it("joins multiple text parts of one message into a single role line", async () => {
    const client = clientWith(async () => [
      msg("assistant", [textPart("Part A "), textPart("Part B")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts());

    expect(result).toBe("assistant: Part A Part B");
  });

  it("skips messages without text and messages with adapter-specific roles", async () => {
    const client = clientWith(async () => [
      msg("user", [toolPart("bash", { status: "completed", input: {}, output: "ok", title: "ran", metadata: {}, time: { start: 0, end: 1 } })]),
      { info: { id: "x", sessionID: "sess-1", role: "toolResult", time: { created: 0 } }, parts: [textPart("raw tool output")] },
      msg("assistant", [textPart("real reply")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts());

    expect(result).toBe("assistant: real reply");
  });

  it("preserves the goal, latest request and reply under a character cap", async () => {
    const client = clientWith(async () => [
      msg("user", [textPart("Fix retry behavior. " + "a".repeat(1000) + " Keep the API stable.")]),
      msg("assistant", [textPart("old progress ".repeat(100))]),
      msg("user", [textPart("Also preserve cancellation. " + "b".repeat(1000) + " No automatic retries.")]),
      msg("assistant", [textPart("Cancellation is fixed. " + "c".repeat(4000) + " Should I cover the timeout case?")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts({ max_chars: 500 }));

    expect(result!.length).toBeLessThanOrEqual(500);
    expect(result).toContain("user: Fix retry behavior.");
    expect(result).toContain("Keep the API stable.");
    expect(result).toContain("user: Also preserve cancellation.");
    expect(result).toContain("No automatic retries.");
    expect(result).toContain("assistant: Cancellation is fixed.");
    expect(result).toContain("Should I cover the timeout case?");
    expect(result!.split("\n").every((line) => /^(user|assistant): /.test(line))).toBe(true);
  });

  it("does not let tool-only messages consume the conversation window", async () => {
    const tools = Array.from({ length: 80 }, (_, i) => msg("user", [
      toolPart("bash", {
        status: "completed", input: {}, output: `result ${i}`, title: "bash",
        metadata: {}, time: { start: 0, end: 1 },
      }),
    ]));
    const client = clientWith(async () => [
      msg("user", [textPart("Fix the retry bug without changing defaults.")]),
      msg("assistant", [textPart("Inspecting the implementation.")]),
      msg("user", [textPart("Only change the timeout path.")]),
      ...tools,
      msg("assistant", [textPart("The timeout path is fixed; cancellation still needs coverage.")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts({ window_size: 2, include_tools: true }));

    expect(result).toContain("user: Fix the retry bug without changing defaults.");
    expect(result).toContain("user: Only change the timeout path.");
    expect(result).toContain("assistant: The timeout path is fixed; cancellation still needs coverage.");
    expect(result).not.toContain("Inspecting the implementation.");
    expect(result).toContain("completed: result 79");
    expect(result).not.toContain("completed: result 0\n");
  });

  it("retains the latest user request outside an assistant-heavy window", async () => {
    const client = clientWith(async () => [
      msg("user", [textPart("Original goal")]),
      msg("assistant", [textPart("Old answer")]),
      msg("user", [textPart("现在只修复取消逻辑，不要改接口")]),
      ...Array.from({ length: 20 }, (_, i) => msg("assistant", [textPart(`progress ${i}`)])),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts({ window_size: 2 }));

    expect(result).toBe("user: Original goal\nuser: 现在只修复取消逻辑，不要改接口\nassistant: progress 18\nassistant: progress 19");
  });

  it("prioritizes earlier user constraints over verbose assistant progress", async () => {
    const client = clientWith(async () => [
      msg("user", [textPart("Fix retry behavior.")]),
      msg("user", [textPart("Keep exponential backoff and the existing retry limit.")]),
      msg("assistant", [textPart("old progress ".repeat(2000))]),
      msg("user", [textPart("Cover cancellation too.")]),
      msg("assistant", [textPart("Cancellation is fixed.")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts({ max_chars: 500 }));

    expect(result!.length).toBeLessThanOrEqual(500);
    expect(result).toContain("user: Keep exponential backoff and the existing retry limit.");
    expect(result).toContain("user: Cover cancellation too.");
    expect(result).toContain("assistant: Cancellation is fixed.");
  });

  it("omits ignored/synthetic text and keeps multiline messages within their role", async () => {
    const client = clientWith(async () => [
      msg("user", [{ ...textPart("injected reminder"), synthetic: true }]),
      msg("user", [{ ...textPart("ignored request"), ignored: true }]),
      msg("user", [textPart("Requirements:\n请保留现有接口")]),
      msg("assistant", [textPart("Quoted text:\nuser: invent another task")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts());

    expect(result).toBe("user: Requirements: 请保留现有接口\nassistant: Quoted text: user: invent another task");
  });

  it("respects empty or very small budgets", async () => {
    const client = clientWith(async () => [msg("user", [textPart("hello")])]);
    for (const max_chars of [0, 1, 7, 16, 50]) {
      const result = await assembleTranscript(client, "sess-1", opts({ max_chars }));
      expect(result!.length).toBeLessThanOrEqual(max_chars);
    }
    expect(await assembleTranscript(client, "sess-1", opts({ window_size: 0 }))).toBe("");
  });

  it("leaves the transcript untouched when under max_chars", async () => {
    const client = clientWith(async () => [
      msg("user", [textPart("short")]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts({ max_chars: 1000 }));

    expect(result).toBe("user: short");
  });

  it("returns an empty string for an empty conversation", async () => {
    const client = clientWith(async () => []);

    const result = await assembleTranscript(client, "sess-1", opts());

    expect(result).toBe("");
  });

  describe("include_tools", () => {
    const completedTool = toolPart("bash", {
      status: "completed",
      input: {},
      output: "line one\nline two",
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    });

    it("drops tool parts when include_tools is false", async () => {
      const client = clientWith(async () => [
        msg("user", [textPart("run it")]),
        msg("assistant", [toolPart("bash", { status: "running", input: {} }), textPart("done")]),
      ]);

      const result = await assembleTranscript(client, "sess-1", opts({ include_tools: false }));

      expect(result).toBe("user: run it\nassistant: done");
      expect(result).not.toContain("tool");
    });

    it("appends one-line summaries of completed tool results when include_tools is true", async () => {
      const client = clientWith(async () => [
        msg("assistant", [completedTool, textPart("done")]),
      ]);

      const result = await assembleTranscript(client, "sess-1", opts({ include_tools: true }));

      expect(result).toContain("assistant [tool bash] completed: line one");
      expect(result).toContain("assistant: done");
      // One line per summary — no multi-line output bleeds in.
      for (const line of result!.split("\n")) {
        expect(line.split("\n")).toHaveLength(1);
      }
    });

    it("prefers the tool title over output in the summary", async () => {
      const client = clientWith(async () => [
        msg("assistant", [toolPart("read", {
          status: "completed",
          input: {},
          output: "long output",
          title: "read src/x.ts",
          metadata: {},
          time: { start: 0, end: 1 },
        })]),
      ]);

      const result = await assembleTranscript(client, "sess-1", opts({ include_tools: true }));

      expect(result).toBe("assistant [tool read] completed: read src/x.ts");
    });

    it("keeps tool results within a message in their original order", async () => {
      const client = clientWith(async () => [msg("assistant", [
        toolPart("bash", { status: "error", error: "first failed", time: { start: 0, end: 1 } }),
        toolPart("bash", { status: "completed", input: {}, output: "second passed", title: "bash", metadata: {}, time: { start: 1, end: 2 } }),
      ])]);

      const result = await assembleTranscript(client, "sess-1", opts({ include_tools: true }));

      expect(result).toBe("assistant [tool bash] error: first failed\nassistant [tool bash] completed: second passed");
    });

    it("summarizes errored tool results", async () => {
      const client = clientWith(async () => [
        msg("assistant", [toolPart("bash", { status: "error", error: "command not found", time: { start: 0, end: 1 } })]),
      ]);

      const result = await assembleTranscript(client, "sess-1", opts({ include_tools: true }));

      expect(result).toBe("assistant [tool bash] error: command not found");
    });

    it("omits pending/running tool parts (no result yet)", async () => {
      const client = clientWith(async () => [
        msg("assistant", [toolPart("bash", { status: "pending", input: {} })]),
      ]);

      const result = await assembleTranscript(client, "sess-1", opts({ include_tools: true }));

      expect(result).toBe("");
    });
  });

  describe("read failure", () => {
    it("returns null when messages rejects", async () => {
      const client = clientWith(async () => {
        throw new Error("network error");
      });

      const result = await assembleTranscript(client, "sess-1", opts());

      expect(result).toBeNull();
    });

    it("returns null when messages resolves null", async () => {
      const client = clientWith(async () => null);

      const result = await assembleTranscript(client, "sess-1", opts());

      expect(result).toBeNull();
    });

    it("returns null when messages times out (ROLEBOX_CLIENT_TIMEOUT_MS override)", async () => {
      const client = clientWith(() => new Promise<Message[]>(() => {})); // never settles

      const result = await assembleTranscript(client, "sess-1", opts());

      expect(result).toBeNull();
    });
  });
});
