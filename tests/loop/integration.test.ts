import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  createPluginHooks,
  activeLoopManager,
  pendingCorrections,
  userMessagedSessions,
  loopManagerMap,
  managerMap,
} from "../../src/plugin-hooks";
import { STOP_LOOP_SIGNAL } from "../../src/loop/constants";

function pluginMockClient(): OpencodeClient {
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
        Promise.resolve({ data: true, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

const AGENT = "test-agent";

describe("LoopManager integration", () => {
  beforeEach(() => {
    mock.restore();
  });

  describe("Recursion block", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-recur-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("rejects |loop| activation on a session already registered as loop origin", async () => {
      const sid = "ses_recursion";

      const output1 = {
        parts: [{ type: "text" as const, text: "|loop:3| first loop" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output1,
      );
      expect(activeLoopManager?.isLoopSession(sid)).toBe(true);

      const output2 = {
        parts: [{ type: "text" as const, text: "|loop:5| nested loop attempt" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output2,
      );

      const correction = pendingCorrections.get(sid);
      expect(correction).toContain("Nested loops are not supported");
    });

    it("does not block |loop| on a fresh non-loop session", async () => {
      const sid = "ses_fresh_loop";

      const output = {
        parts: [{ type: "text" as const, text: "|loop:2| start fresh" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output,
      );

      expect(activeLoopManager?.isLoopSession(sid)).toBe(true);
      const correction = pendingCorrections.get(sid);
      expect(correction ?? "").not.toContain("Nested loops are not supported");
    });
  });

  describe("Cancellation via user message", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-cancel-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("shouldCancelOnUserMessage marks cancelRequested on genuine user message", async () => {
      const sid = "ses_cancel_001";

      activeLoopManager!.register({
        originSessionId: sid,
        agent: AGENT,
        prompt: "do the loop thing",
        mode: "fresh",
        iterations: 5,
      });

      // Set phase to awaitable state for cancellation
      const loopState = activeLoopManager!.getLoopState(sid)!;
      loopState.phase = "awaiting_worker";

      const output = {
        parts: [{ type: "text" as const, text: STOP_LOOP_SIGNAL }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output,
      );

      expect(activeLoopManager!.getLoopState(sid)!.cancelRequested).toBe(true);
      expect(userMessagedSessions.has(sid)).toBe(true);
    });
  });
});
