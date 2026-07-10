import { describe, it, expect, mock } from "bun:test";
import { DispatchAdapter, type IDispatchAdapter } from "../../src/loop/dispatch-adapter";
import type { DispatchInput, DispatchTask } from "../../src/dispatch/types";

interface FakeDispatchManager {
  launch: ReturnType<typeof mock>;
  getResult: ReturnType<typeof mock>;
  cancelTask: ReturnType<typeof mock>;
}

function createFakeDispatchManager(): FakeDispatchManager {
  return {
    launch: mock(
      (
        _input: DispatchInput,
        _parentContext: { sessionID: string; agent: string; directory: string },
      ): Promise<DispatchTask> =>
        Promise.resolve({
          id: "fake-task-id",
          sessionId: "fake-session-id",
          parentSessionId: _parentContext.sessionID,
          depth: 0,
          status: "running",
          agent: _input.subagent,
          prompt: _input.prompt,
          description: _input.description,
          startedAt: new Date(),
          progress: { lastUpdate: new Date(), toolCalls: 0 },
        }),
    ),
    getResult: mock(
      (_taskId: string): Promise<{
        kind: "ok" | "expired" | "not_found" | "fetch_error";
        text: string;
        resultText: string;
        hadFence: boolean;
        totalChars: number;
        error?: string;
      }> =>
        Promise.resolve({
          kind: "ok",
          text: "worker output text",
          resultText: "worker output text",
          hadFence: false,
          totalChars: 18,
        }),
    ),
    cancelTask: mock(
      (_taskId: string): Promise<boolean> => Promise.resolve(true),
    ),
  };
}

function createFakeClient(overrides?: {
  messages?: Array<{
    info?: { role?: string; id?: string };
    parts?: Array<{ type: string; text?: string }>;
  }>;
}): import("../../src/platform/ports/session-client").ISessionClient {
  const data = overrides?.messages ?? [];
  return {
    messages: mock(() => Promise.resolve(data)),
    prompt: mock(() => Promise.resolve({ id: "prompt-1" })),
    create: mock(() => Promise.resolve({ id: "test-session-1" })),
    promptSync: mock(() => Promise.resolve(null)),
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve([])),
    children: mock(() => Promise.resolve([])),
    todo: mock(() => Promise.resolve([])),
    diff: mock(() => Promise.resolve([])),
    fork: mock(() => Promise.resolve(null)),
    status: mock(() => Promise.resolve(null)),
    abort: mock(() => Promise.resolve(true)),
  } as unknown as import("../../src/platform/ports/session-client").ISessionClient;
}

describe("DispatchAdapter", () => {
  let dispatchManager: FakeDispatchManager;
  let client: import("../../src/platform/ports/session-client").ISessionClient;
  let adapter: IDispatchAdapter;

  function freshAdapter(clientOverrides?: {
    messages?: Array<{
      info?: { role?: string; id?: string };
      parts?: Array<{ type: string; text?: string }>;
    }>;
  }) {
    dispatchManager = createFakeDispatchManager();
    client = createFakeClient(clientOverrides);
    adapter = new DispatchAdapter(
      dispatchManager as unknown as import("../../src/dispatch/core/manager").DispatchManager,
      client,
    );
  }

  describe("dispatchRound", () => {
    it("calls dispatchManager.launch with correct args", async () => {
      freshAdapter();

      const result = await adapter.dispatchRound({
        originSessionId: "origin-123",
        agent: "worker-agent",
        prompt: "do the thing",
        description: "round 1",
      });

      expect(dispatchManager.launch).toHaveBeenCalledTimes(1);
      const [input, parentContext] = dispatchManager.launch.mock
        .calls[0] as [DispatchInput, { sessionID: string; agent: string; directory: string }];
      expect(input.subagent).toBe("worker-agent");
      expect(input.prompt).toBe("do the thing");
      expect(input.run_in_background).toBe(true);
      expect(input.description).toBe("round 1");
      expect(input.noParentInherit).toBe(true);
      expect(parentContext.sessionID).toBe("origin-123");

      expect(result.workerTaskId).toBe("fake-task-id");
      expect(result.workerSessionId).toBe("fake-session-id");
    });
  });

  describe("getRoundResult", () => {
    it("returns text and no error for ok result", async () => {
      freshAdapter();

      const result = await adapter.getRoundResult("task-1");

      expect(dispatchManager.getResult).toHaveBeenCalledWith("task-1");
      expect(result.text).toBe("worker output text");
      expect(result.hadError).toBe(false);
      expect(result.errorReason).toBeUndefined();
    });

    it("returns hadError=true when kind is not ok", async () => {
      freshAdapter();
      dispatchManager.getResult = mock(() =>
        Promise.resolve({
          kind: "fetch_error" as const,
          text: "",
          resultText: "",
          hadFence: false,
          totalChars: 0,
          error: "fetch failed",
        }),
      );

      const result = await adapter.getRoundResult("task-1");

      expect(result.hadError).toBe(true);
      expect(result.errorReason).toBe("fetch failed");
    });
  });

  describe("cancelRound", () => {
    it("forwards taskId to dispatchManager.cancelTask", async () => {
      freshAdapter();

      await adapter.cancelRound("task-to-cancel");

      expect(dispatchManager.cancelTask).toHaveBeenCalledWith(
        "task-to-cancel",
      );
    });
  });

  describe("readOriginSummary", () => {
    it("returns empty string when no messages", async () => {
      freshAdapter({ messages: [] });

      const summary = await adapter.readOriginSummary("origin-123");

      expect(summary).toBe("");
    });

    it("returns latest assistant text", async () => {
      freshAdapter({
        messages: [
          {
            info: { role: "user", id: "msg-1" },
            parts: [{ type: "text", text: "user message" }],
          },
          {
            info: { role: "assistant", id: "msg-2" },
            parts: [{ type: "text", text: "assistant response" }],
          },
        ],
      });

      const summary = await adapter.readOriginSummary("origin-123");

      expect(summary).toBe("assistant response");
    });

    it("concatenates multiple assistant text parts", async () => {
      freshAdapter({
        messages: [
          {
            info: { role: "assistant", id: "msg-1" },
            parts: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
          },
        ],
      });

      const summary = await adapter.readOriginSummary("origin-123");

      expect(summary).toBe("part one part two");
    });

    it("captures only messages after sinceMessageId (exclusive)", async () => {
      freshAdapter({
        messages: [
          {
            info: { role: "assistant", id: "msg-1" },
            parts: [{ type: "text", text: "old content" }],
          },
          {
            info: { role: "assistant", id: "msg-2" },
            parts: [{ type: "text", text: "new content" }],
          },
        ],
      });

      const summary = await adapter.readOriginSummary("origin-123", "msg-1");

      expect(summary).toBe("new content");
    });

    it("caps output at SUMMARY_INPUT_CHAR_CAP", async () => {
      const longText = "a".repeat(10_000);
      freshAdapter({
        messages: [
          {
            info: { role: "assistant", id: "msg-1" },
            parts: [{ type: "text", text: longText }],
          },
        ],
      });

      const summary = await adapter.readOriginSummary("origin-123");

      expect(summary.length).toBe(8_000);
      expect(summary).toBe("a".repeat(8_000));
    });

    it("does not cap output shorter than limit", async () => {
      freshAdapter({
        messages: [
          {
            info: { role: "assistant", id: "msg-1" },
            parts: [{ type: "text", text: "short text" }],
          },
        ],
      });

      const summary = await adapter.readOriginSummary("origin-123");

      expect(summary).toBe("short text");
    });
  });
});
