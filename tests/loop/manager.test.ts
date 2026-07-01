import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { LoopManager } from "../../src/loop/manager";
import { LOOP_PROGRESS_MARKER } from "../../src/loop/constants";
import type { LoopState } from "../../src/loop/types";

// ── mock factory ──────────────────────────────────────────────────

/** Creates an OpencodeClient mock with all session methods needed by LoopManager. */
function loopMockClient(overrides?: {
  sessionCreate?: (...args: unknown[]) => unknown;
  sessionPromptAsync?: (...args: unknown[]) => unknown;
  sessionPrompt?: (...args: unknown[]) => unknown;
  sessionMessages?: (...args: unknown[]) => unknown;
  sessionDelete?: (...args: unknown[]) => unknown;
}): OpencodeClient {
  return {
    session: {
      create: mock(
        overrides?.sessionCreate ??
          (() =>
            Promise.resolve({
              data: { id: "test-session-1" },
              error: undefined,
            })),
      ),
      promptAsync: mock(
        overrides?.sessionPromptAsync ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
      prompt: mock(
        overrides?.sessionPrompt ??
          (() =>
            Promise.resolve({
              data: {
                parts: [{ type: "text" as const, text: "summary from mock" }],
              },
              error: undefined,
            })),
      ),
      messages: mock(
        overrides?.sessionMessages ??
          (() =>
            Promise.resolve({
              data: [],
              error: undefined,
            })),
      ),
      delete: mock(
        overrides?.sessionDelete ??
          (() =>
            Promise.resolve({
              data: true,
              error: undefined,
            })),
      ),
    },
  } as unknown as OpencodeClient;
}

// ── helpers ───────────────────────────────────────────────────────

/** Build a sequential ID generator for session.create mocks. */
function sequentialIds(prefix: string): () => unknown {
  let n = 1;
  return () =>
    Promise.resolve({ data: { id: `${prefix}-${n++}` }, error: undefined });
}

/** Extract the text part body from a promptAsync call args[0]. */
function promptAsyncBody(call: unknown[]): {
  agent?: string;
  parts?: Array<{ type: string; text?: string }>;
  noReply?: boolean;
} {
  const arg = (call[0] as { body?: Record<string, unknown> })?.body ?? {};
  return arg as {
    agent?: string;
    parts?: Array<{ type: string; text?: string }>;
    noReply?: boolean;
  };
}

/** Extract the path.id from a promptAsync call args[0]. */
function promptAsyncPathId(call: unknown[]): string | undefined {
  const arg = call[0] as { path?: { id?: string } } | undefined;
  return arg?.path?.id;
}

/** Extract the body from a session.create call args[0]. */
function createBody(call: unknown[]): { parentID?: string } | undefined {
  const arg = call[0] as { body?: { parentID?: string } } | undefined;
  return arg?.body;
}

/** Find promptAsync calls targeting a specific session ID. */
function callsTo(
  calls: unknown[][],
  sessionId: string,
): unknown[][] {
  return calls.filter((c) => promptAsyncPathId(c) === sessionId);
}

const ORIGIN_SID = "origin-session-1";
const AGENT = "test-agent";
const PROMPT = "do the loop thing";

// ── tests ────────────────────────────────────────────────────────

describe("LoopManager", () => {
  beforeEach(() => {
    mock.restore();
  });

  function freshManager(client?: OpencodeClient): LoopManager {
    // delayMs=0 so tests run instantly
    return new LoopManager(client ?? loopMockClient(), { delayMs: 0 });
  }

  // ── register ──────────────────────────────────────────────────

  describe("register", () => {
    it("creates a loop state with correct fields", () => {
      const manager = freshManager();

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 5,
      });

      expect(manager.isLoopOrigin(ORIGIN_SID)).toBe(true);
      expect(manager.isLoopSession(ORIGIN_SID)).toBe(true);
      expect(manager.isLoopChild(ORIGIN_SID)).toBe(false);

      const loop = manager.getByActiveSession(ORIGIN_SID);
      expect(loop).toBeDefined();
      expect(loop!.agent).toBe(AGENT);
      expect(loop!.prompt).toBe(PROMPT);
      expect(loop!.mode).toBe("fresh");
      expect(loop!.total).toBe(5);
      expect(loop!.current).toBe(1);
      expect(loop!.status).toBe("running");
      expect(loop!.activeSessionId).toBe(ORIGIN_SID);
      expect(loop!.cancelRequested).toBe(false);
      expect(loop!.schemaVersion).toBe(1);
    });

    it("duplicate register for same origin returns silently (no double-start)", () => {
      const manager = freshManager();

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Second register with different params — should be a no-op
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: "other-agent",
        prompt: "different prompt",
        mode: "inherit",
        iterations: 10,
      });

      const loop = manager.getByActiveSession(ORIGIN_SID);
      expect(loop).toBeDefined();
      expect(loop!.agent).toBe(AGENT);
      expect(loop!.total).toBe(3);
      expect(loop!.mode).toBe("fresh");
    });
  });

  // ── isLoopSession / isLoopOrigin / isLoopChild ─────────────────

  describe("session identity queries", () => {
    it("isLoopSession returns true for origin sessions", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });
      expect(manager.isLoopSession(ORIGIN_SID)).toBe(true);
      expect(manager.isLoopSession("unknown")).toBe(false);
    });

    it("isLoopOrigin returns true only for origin", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });
      expect(manager.isLoopOrigin(ORIGIN_SID)).toBe(true);
      expect(manager.isLoopOrigin("some-child")).toBe(false);
    });

    it("isLoopChild returns false for origin, true for registered child", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Advance to create first child
      await manager.onRoundComplete(ORIGIN_SID);

      const childId = "child-1";
      expect(manager.isLoopChild(childId)).toBe(true);
      expect(manager.isLoopSession(childId)).toBe(true);
      expect(manager.isLoopChild(ORIGIN_SID)).toBe(false);
    });
  });

  // ── getByActiveSession ──────────────────────────────────────────

  describe("getByActiveSession", () => {
    it("returns undefined for unknown session", () => {
      const manager = freshManager();
      expect(manager.getByActiveSession("nope")).toBeUndefined();
    });

    it("returns loop by child session ID after advance", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const childId = "child-1";
      const loop = manager.getByActiveSession(childId);
      expect(loop).toBeDefined();
      expect(loop!.originSessionId).toBe(ORIGIN_SID);
    });
  });

  // ── onRoundComplete: iterations=1 ───────────────────────────────

  describe("onRoundComplete — iterations=1", () => {
    it("completes immediately with ZERO session.create calls", async () => {
      const client = loopMockClient();
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 1,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      expect(client.session.create).not.toHaveBeenCalled();

      const loop = manager.getByActiveSession(ORIGIN_SID);
      expect(loop).toBeDefined();
      expect(loop!.status).toBe("complete");
    });

    it("injects a completion note into origin with LOOP_PROGRESS_MARKER and noReply:true", async () => {
      const client = loopMockClient();
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 1,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const allCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);
      expect(originCalls.length).toBeGreaterThanOrEqual(1);

      const last = originCalls[originCalls.length - 1];
      const body = promptAsyncBody(last);
      expect(body.noReply).toBe(true);
      const text = body.parts?.[0]?.text ?? "";
      expect(text).toContain(LOOP_PROGRESS_MARKER);
      expect(text).toContain("loop complete");
    });
  });

  // ── onRoundComplete: iterations=3 fresh ─────────────────────────

  describe("onRoundComplete — iterations=3 fresh", () => {
    it("performs 2 session.create + 2 child promptAsync with correct agent/prompt", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Round 1 → creates child-1
      await manager.onRoundComplete(ORIGIN_SID);
      // Round 2 → creates child-2
      const loop = manager.getByActiveSession("child-1")!;
      await manager.onRoundComplete("child-1");
      // Round 3 → complete
      await manager.onRoundComplete("child-2");

      // 2 child sessions created
      expect(client.session.create).toHaveBeenCalledTimes(2);

      // Both create calls used parentID = origin
      const createCalls = (client.session.create as any).mock
        .calls as unknown[][];
      for (const call of createCalls) {
        expect(createBody(call)?.parentID).toBe(ORIGIN_SID);
      }

      // 2 promptAsync for children (not counting origin notes)
      const allPromptCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
      const childCalls = allPromptCalls.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(childCalls.length).toBe(2);

      // Each child promptAsync has correct agent and the base prompt
      for (const call of childCalls) {
        const body = promptAsyncBody(call);
        expect(body.agent).toBe(AGENT);
        expect(body.parts?.[0]?.text).toBe(PROMPT);
      }
    });

    it("final status is complete after all rounds", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);
      await manager.onRoundComplete("child-1");
      await manager.onRoundComplete("child-2");

      const loop = manager.getByActiveSession("child-2");
      expect(loop!.status).toBe("complete");
      expect(loop!.current).toBe(3);
    });
  });

  // ── onRoundComplete: iterations=3 inherit ───────────────────────

  describe("onRoundComplete — iterations=3 inherit", () => {
    it("summarizer invoked between rounds; child prompt begins with summary", async () => {
      const SUMMARY_TEXT = "**Round summary**: fixed 3 bugs, wrote 5 tests.";
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
        sessionMessages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "user" as const },
                parts: [{ type: "text" as const, text: "do something" }],
              },
              {
                info: { role: "assistant" as const },
                parts: [
                  { type: "text" as const, text: "I fixed 3 bugs." },
                  { type: "text" as const, text: "I wrote 5 tests." },
                ],
              },
            ],
            error: undefined,
          }),
        sessionPrompt: () =>
          Promise.resolve({
            data: {
              parts: [{ type: "text" as const, text: SUMMARY_TEXT }],
            },
            error: undefined,
          }),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "inherit",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      // Summarizer was called (session.prompt used for summarization)
      expect(client.session.prompt).toHaveBeenCalled();

      // Child prompt starts with summary text followed by separator + base prompt
      const allPromptCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
      const childCalls = allPromptCalls.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(childCalls.length).toBe(1);

      const childPrompt = promptAsyncBody(childCalls[0]).parts?.[0]?.text ?? "";
      expect(childPrompt).toContain(SUMMARY_TEXT);
      expect(childPrompt).toContain("---");
      expect(childPrompt).toContain(PROMPT);

      // lastSummary is stored (summarizer consumed child-1 for its temp session)
      const loop = manager.getByActiveSession("child-2");
      expect(loop!.lastSummary).toBe(SUMMARY_TEXT);
    });

    it("falls back to base prompt when summarizer returns ok:false", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
        sessionMessages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "assistant" as const },
                parts: [{ type: "text" as const, text: "Round 1 output." }],
              },
            ],
            error: undefined,
          }),
        sessionPrompt: () =>
          Promise.resolve({
            data: undefined,
            error: { message: "summarizer failed" },
          }),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "inherit",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      // Child prompt is just the base prompt (fresh fallback)
      const allPromptCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
      const childCalls = allPromptCalls.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(childCalls.length).toBe(1);
      expect(promptAsyncBody(childCalls[0]).parts?.[0]?.text).toBe(PROMPT);
    });
  });

  // ── requestCancel ────────────────────────────────────────────────

  describe("requestCancel", () => {
    it("before advance → cancelRequested=true; next onRoundComplete cancels immediately", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Complete first round (advance to child-1)
      await manager.onRoundComplete(ORIGIN_SID);

      // Request cancel BEFORE next onRoundComplete
      manager.requestCancel(ORIGIN_SID);

      const loop = manager.getByActiveSession("child-1");
      expect(loop!.cancelRequested).toBe(true);

      // Now advance → should cancel instead of creating new session
      await manager.onRoundComplete("child-1");

      expect(loop!.status).toBe("cancelled");

      // session.create should NOT have been called a second time
      expect(client.session.create).toHaveBeenCalledTimes(1);
    });

    it("during waiting status → finalizes to cancelled immediately", async () => {
      // We can't easily test the "waiting" transition directly since
      // onRoundComplete doesn't go through waiting. But requestCancel
      // handles it via the status check — verify the mechanism works.
      const client = loopMockClient();
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 1,
      });

      // Manually set status to waiting (simulating between-round state)
      const loop = manager.getByActiveSession(ORIGIN_SID)!;
      loop.status = "waiting";

      manager.requestCancel(ORIGIN_SID);

      expect(loop.status).toBe("cancelled");

      // Verify a cancel note was injected into origin
      const allCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);
      const cancelCall = originCalls[originCalls.length - 1];
      expect(promptAsyncBody(cancelCall).noReply).toBe(true);
      expect(promptAsyncBody(cancelCall).parts?.[0]?.text).toContain(
        "loop cancelled",
      );
    });
  });

  // ── progress notes ───────────────────────────────────────────────

  describe("progress notes", () => {
    it("use noReply:true and contain LOOP_PROGRESS_MARKER", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const allCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);

      // There should be at least 1 progress note to origin
      expect(originCalls.length).toBeGreaterThanOrEqual(1);

      for (const call of originCalls) {
        const body = promptAsyncBody(call);
        expect(body.noReply).toBe(true);
        const text = body.parts?.[0]?.text ?? "";
        expect(text).toContain(LOOP_PROGRESS_MARKER);
      }
    });
  });

  // ── handleSessionError ───────────────────────────────────────────

  describe("handleSessionError", () => {
    it("child error → status=error, origin note injected, child mapping cleared", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const childId = "child-1";
      expect(manager.isLoopChild(childId)).toBe(true);

      manager.handleSessionError(childId, "API rate limit exceeded");

      const loop = manager.getByActiveSession(childId);
      expect(loop).toBeDefined();
      expect(loop!.status).toBe("error");
      expect(loop!.errorReason).toBe("API rate limit exceeded");

      // Child mapping cleared
      expect(manager.isLoopChild(childId)).toBe(false);

      // Error note injected into origin
      const allCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
      // Find origin calls that mention error
      const errorCalls = allCalls.filter(
        (c) =>
          promptAsyncPathId(c) === ORIGIN_SID &&
          (promptAsyncBody(c).parts?.[0]?.text ?? "").includes("error"),
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("origin error → status=error with error reason set", () => {
      const manager = freshManager();

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      manager.handleSessionError(ORIGIN_SID, "origin crashed");

      const loop = manager.getByActiveSession(ORIGIN_SID);
      expect(loop!.status).toBe("error");
      expect(loop!.errorReason).toBe("origin crashed");
    });

    it("unknown session → no-op", () => {
      const manager = freshManager();
      // Should not throw
      manager.handleSessionError("unknown-sid", "some error");
    });
  });

  // ── dispose ──────────────────────────────────────────────────────

  describe("dispose", () => {
    it("clears internal timer", () => {
      const manager = freshManager();
      // dispose should not throw
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  // ── non-running status guard ─────────────────────────────────────

  describe("onRoundComplete guards", () => {
    it("returns early when status is not running", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Manually set status to error
      const loop = manager.getByActiveSession(ORIGIN_SID)!;
      loop.status = "error";

      await manager.onRoundComplete(ORIGIN_SID);

      // No session.create should have been called
      expect(client.session.create).not.toHaveBeenCalled();
    });

    it("returns early for unknown session ID", async () => {
      const client = loopMockClient();
      const manager = freshManager(client);

      await manager.onRoundComplete("unknown");

      expect(client.session.create).not.toHaveBeenCalled();
      expect(client.session.promptAsync).not.toHaveBeenCalled();
    });
  });

  // ── setStoreDirectory + recover ──────────────────────────────────

  describe("setStoreDirectory + recover", () => {
    it("recover loads persisted loops and marks non-terminal as interrupted", () => {
      // We test the recover logic by using an in-memory map directly
      // since mkdtemp is available but we test the pure logic.
      const manager = freshManager();

      // First, set up a store and persist a loop
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const tmpDir = path.join(os.tmpdir(), `lm-recover-${Date.now()}`);
      fs.mkdirSync(path.join(tmpDir, ".rolebox", "state"), {
        recursive: true,
      });

      const hash = require("node:crypto")
        .createHash("sha256")
        .update(tmpDir)
        .digest("hex")
        .slice(0, 12);
      const statePath = path.join(
        tmpDir,
        ".rolebox",
        "state",
        `loops-${hash}.json`,
      );
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            version: 1,
            loops: [
              {
                id: "origin-rec",
                state: {
                  originSessionId: "origin-rec",
                  agent: "recover-agent",
                  prompt: "recover me",
                  mode: "fresh",
                  total: 5,
                  current: 3,
                  status: "running",
                  activeSessionId: "child-rec",
                  lastSummary: undefined,
                  cancelRequested: false,
                  errorReason: undefined,
                  startedAt: Date.now() - 3600_000,
                  updatedAt: Date.now(),
                  roundStartedAt: Date.now() - 60000,
                  schemaVersion: 1,
                },
              },
            ],
          },
          null,
          2,
        ),
      );

      manager.setStoreDirectory(tmpDir);
      manager.recover();

      // Loop was loaded and marked interrupted
      expect(manager.isLoopOrigin("origin-rec")).toBe(true);
      expect(manager.isLoopChild("child-rec")).toBe(true);

      const loop = manager.getByActiveSession("child-rec");
      expect(loop).toBeDefined();
      expect(loop!.status).toBe("interrupted");
      expect(loop!.agent).toBe("recover-agent");
      expect(loop!.total).toBe(5);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("recover is a no-op when no store directory is set", () => {
      const manager = freshManager();
      // Should not throw
      expect(() => manager.recover()).not.toThrow();
    });
  });
});
