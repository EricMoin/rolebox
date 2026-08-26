import { describe, it, expect, mock, afterAll } from "bun:test";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { Message, Part, ToolPart } from "../src/session/types.ts";

// ── Timeout override ────────────────────────────────────────────────────────
// DEFAULT_TIMEOUT_MS is computed once at module load from
// ROLEBOX_CLIENT_TIMEOUT_MS. Setting it before the first (dynamic) import of
// the transcript module makes the real-timeout test fast instead of 30s.
// bun test runs each file in an isolated process (--isolate), so this does
// not leak into other test files.
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
  return { messages: mock(handler) } as unknown as ISessionClient;
}

const opts = (overrides: Partial<{ window_size: number; max_chars: number; include_tools: boolean }> = {}) => ({
  window_size: 10,
  max_chars: 10_000,
  include_tools: false,
  ...overrides,
});

// ── assembleTranscript ──────────────────────────────────────────────────────

describe("assembleTranscript", () => {
  it("passes window_size as the messages limit and keeps only the tail window", async () => {
    const messages = [
      msg("user", [textPart("m1")], "id-1"),
      msg("assistant", [textPart("m2")], "id-2"),
      msg("user", [textPart("m3")], "id-3"),
      msg("assistant", [textPart("m4")], "id-4"),
      msg("user", [textPart("m5")], "id-5"),
    ];
    const client = clientWith(async (sid, o) => {
      // Record the call args; return MORE than requested to prove the
      // tail window is enforced defensively even if the client ignores
      // the limit.
      return messages;
    });

    const result = await assembleTranscript(client, "sess-1", opts({ window_size: 3 }));

    expect(client.messages).toHaveBeenCalledWith("sess-1", { limit: 3 });
    expect(result).toBe("user: m3\nassistant: m4\nuser: m5");
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

  it("tail-truncates to max_chars keeping the most recent content", async () => {
    const client = clientWith(async () => [
      msg("user", [textPart("a".repeat(100))]),
      msg("assistant", [textPart("b".repeat(100))]),
      msg("user", [textPart("c".repeat(100))]),
    ]);

    const result = await assembleTranscript(client, "sess-1", opts({ max_chars: 50 }));

    const full = "user: " + "a".repeat(100) + "\nassistant: " + "b".repeat(100) + "\nuser: " + "c".repeat(100);
    expect(result!.length).toBe(50);
    expect(result).toBe(full.slice(-50));
    // The most recent content survives the truncation.
    expect(result!.endsWith("c".repeat(50))).toBe(true);
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
