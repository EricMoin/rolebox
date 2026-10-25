import { describe, it, expect, vi } from "vitest";
import { DispatchAdapter, type IDispatchAdapter } from "../../src/loop/dispatch-adapter.ts";
import type { DispatchInput, DispatchTask } from "../../src/dispatch/types.ts";

interface FakeDispatchManager {
  launch: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
  getResult: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
  cancelTask: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
}

function createFakeDispatchManager(): FakeDispatchManager {
  return {
    launch: vi.fn(
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
          priority: 0,
        }),
    ),
    getResult: vi.fn(
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
    cancelTask: vi.fn(
      (_taskId: string): Promise<boolean> => Promise.resolve(true),
    ),
  };
}

function createFakeClient(overrides?: {
  messages?: Array<{
    info?: { role?: string; id?: string };
    parts?: Array<{ type: string; text?: string }>;
  }>;
}): import("../../src/platform/ports/session-client.ts").ISessionClient {
  const data = overrides?.messages ?? [];
  return {
    messages: vi.fn(() => Promise.resolve(data)),
    prompt: vi.fn(() => Promise.resolve({ id: "prompt-1" })),
    create: vi.fn(() => Promise.resolve({ id: "test-session-1" })),
    promptSync: vi.fn(() => Promise.resolve(null)),
    get: vi.fn(() => Promise.resolve(null)),
    list: vi.fn(() => Promise.resolve([])),
    children: vi.fn(() => Promise.resolve([])),
    todo: vi.fn(() => Promise.resolve([])),
    diff: vi.fn(() => Promise.resolve([])),
    fork: vi.fn(() => Promise.resolve(null)),
    status: vi.fn(() => Promise.resolve(null)),
    abort: vi.fn(() => Promise.resolve(true)),
  } as unknown as import("../../src/platform/ports/session-client.ts").ISessionClient;
}

describe("DispatchAdapter", () => {
  let dispatchManager: FakeDispatchManager;
  let client: import("../../src/platform/ports/session-client.ts").ISessionClient;
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
      dispatchManager as unknown as import("../../src/dispatch/core/manager.ts").DispatchManager,
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
      dispatchManager.getResult = vi.fn(() =>
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

  describe("lastProcessedMessageId tracking", () => {
    it("updates lastProcessedMessageId after readOriginSummary", async () => {
      freshAdapter({
        messages: [
          {
            info: { role: "assistant", id: "msg-1" },
            parts: [{ type: "text", text: "first response" }],
          },
        ],
      });

      await adapter.readOriginSummary("origin-123");
      expect((adapter as any).lastProcessedMessageId).toBe("msg-1");
    });

    it("uses lastProcessedMessageId as default sinceMessageId", async () => {
      freshAdapter();
      const da = adapter as any;
      da.lastProcessedMessageId = "msg-1";
      // Override client to return three messages
      da.client = {
        ...da.client,
        messages: vi.fn(() =>
          Promise.resolve([
            { info: { role: "assistant", id: "msg-1" }, parts: [{ type: "text", text: "old" }] },
            { info: { role: "assistant", id: "msg-2" }, parts: [{ type: "text", text: "newer" }] },
            { info: { role: "assistant", id: "msg-3" }, parts: [{ type: "text", text: "latest" }] },
          ]),
        ),
      };

      const summary = await adapter.readOriginSummary("origin-123");

      // Should skip msg-1 and only include msg-2 and msg-3
      expect(summary).not.toContain("old");
      expect(summary).toContain("newer");
      expect(summary).toContain("latest");
    });
  });
});
