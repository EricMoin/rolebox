import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  createPluginHooks,
  userMessagedSessions,
  activeLoopManager,
  pendingCorrections,
  loopManagerMap,
} from "../../src/plugin-hooks";
import { LOOP_PROGRESS_MARKER } from "../../src/loop/constants";
import { functionRuntime } from "../../src/function/runtime-state";

function createMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-child" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({
          data: { parts: [{ type: "text", text: "ok" }] },
          error: undefined,
        }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: "test" }, error: undefined }),
      ),
      delete: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

describe("loop activation", () => {
  let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-test-"));
    pendingCorrections.clear();
    userMessagedSessions.clear();
    const client = createMockClient();
    hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);
  });

  afterEach(() => {
    loopManagerMap.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a loop when |loop:3| is parsed", async () => {
    const output = {
      parts: [{ type: "text" as const, text: "|loop:3| do the thing" }],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_001" },
      output,
    );

    expect(activeLoopManager?.isLoopOrigin("ses_001")).toBe(true);
  });

  it("registers a loop with fresh mode when |loop:5,fresh| is parsed", async () => {
    const output = {
      parts: [
        { type: "text" as const, text: "|loop iterations=5 mode=fresh| work" },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_002" },
      output,
    );

    expect(activeLoopManager?.isLoopOrigin("ses_002")).toBe(true);
  });

  it("rejects |loop| inside an active loop (recursion block)", async () => {
    const output1 = {
      parts: [{ type: "text" as const, text: "|loop:2| first loop" }],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_003" },
      output1,
    );

    const output2 = {
      parts: [
        { type: "text" as const, text: "|loop:3| nested attempt" },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_003" },
      output2,
    );

    const correction = pendingCorrections.get("ses_003");
    expect(correction).toContain("Nested loops are not supported");
  });

  it("adds an invalid-loop-params correction for |loop:0|", async () => {
    const output = {
      parts: [{ type: "text" as const, text: "|loop:0| do work" }],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_004" },
      output,
    );

    const correction = pendingCorrections.get("ses_004");
    expect(correction).toContain("Invalid loop params");
    expect(activeLoopManager?.isLoopOrigin("ses_004")).toBe(false);
  });

  it("clamps to hard cap when |loop:999| exceeds limit", async () => {
    const output = {
      parts: [
        { type: "text" as const, text: "|loop:999| super loop" },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_005" },
      output,
    );

    expect(activeLoopManager?.isLoopOrigin("ses_005")).toBe(true);
    const correction = pendingCorrections.get("ses_005");
    expect(correction).toContain("clamped");
  });

  it("cancels loop when genuine user message arrives on origin", async () => {
    const output1 = {
      parts: [{ type: "text" as const, text: "|loop:5| keep going" }],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_006" },
      output1,
    );

    expect(activeLoopManager?.isLoopOrigin("ses_006")).toBe(true);

    const cancelSpy = spyOn(activeLoopManager!, "requestCancel");

    const output2 = {
      parts: [
        { type: "text" as const, text: "stop everything" },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_006" },
      output2,
    );

    expect(cancelSpy).toHaveBeenCalledWith("ses_006", "user message");
    expect(userMessagedSessions.has("ses_006")).toBe(true);
  });

  it("does NOT add userMessagedSessions for LOOP_PROGRESS_MARKER messages", async () => {
    const output = {
      parts: [
        {
          type: "text" as const,
          text: `${LOOP_PROGRESS_MARKER} round 1/3 done]`,
        },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_007" },
      output,
    );

    expect(userMessagedSessions.has("ses_007")).toBe(false);
  });

  it("does NOT reset continuation counters for LOOP_PROGRESS_MARKER messages", async () => {
    functionRuntime.init("ses_008", "test-fn", 1);
    const st = functionRuntime.get("ses_008", "test-fn")!;
    st.continuationCount = 7;

    const output = {
      parts: [
        {
          type: "text" as const,
          text: `${LOOP_PROGRESS_MARKER} round 2/5 done]`,
        },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_008" },
      output,
    );

    const updated = functionRuntime.get("ses_008", "test-fn");
    expect(updated?.continuationCount).toBe(7);
  });

  it("does NOT trigger auto-continue misclassification via LOOP_PROGRESS_MARKER", async () => {
    const output = {
      parts: [
        {
          type: "text" as const,
          text: `${LOOP_PROGRESS_MARKER} loop complete]`,
        },
      ],
    };
    await hooks["chat.message"](
      { agent: "test-agent", sessionID: "ses_009" },
      output,
    );

    expect(userMessagedSessions.has("ses_009")).toBe(false);
  });
});
