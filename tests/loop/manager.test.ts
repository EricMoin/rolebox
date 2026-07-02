import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { LoopManager } from "../../src/loop/manager";
import { LOOP_PROGRESS_MARKER } from "../../src/loop/constants";
import type { LoopState } from "../../src/loop/types";

// ── mock factory ──────────────────────────────────────────────────

function loopMockClient(overrides?: {
  sessionPromptAsync?: (...args: unknown[]) => unknown;
}): OpencodeClient {
  return {
    session: {
      promptAsync: mock(
        overrides?.sessionPromptAsync ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
    },
  } as unknown as OpencodeClient;
}

// ── helpers ───────────────────────────────────────────────────────

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
    return new LoopManager(client ?? loopMockClient());
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

    it("isLoopChild returns false for origin, true for manually registered child", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Manually register a child (simulating what onRoundComplete used to do)
      const childId = "child-1";
      const loop = manager.getLoopState(ORIGIN_SID)!;
      loop.activeSessionId = childId;
      (manager as any).childToOrigin.set(childId, ORIGIN_SID);

      expect(manager.isLoopChild(childId)).toBe(true);
      expect(manager.isLoopSession(childId)).toBe(true);
      expect(manager.isLoopChild(ORIGIN_SID)).toBe(false);
    });

    it("isLoopSession returns true for activeWorkerSessionId (dispatch model)", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });
      // Set activeWorkerSessionId directly (as DispatchAdapter would)
      const loop = manager.getLoopState(ORIGIN_SID)!;
      (loop as any).activeWorkerSessionId = "worker-ses-001";

      expect(manager.isLoopSession("worker-ses-001")).toBe(true);
      expect(manager.isLoopChild("worker-ses-001")).toBe(true);
      expect(manager.isLoopSession("unknown-worker")).toBe(false);
    });
  });

  // ── shouldCancelOnUserMessage ───────────────────────────────────

  describe("shouldCancelOnUserMessage", () => {
    it("returns false during round 1 (origin-owned phase)", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });
      // Phase is undefined → shouldCancelLoop returns false (no match)
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
    });

    it("returns true when loop is in awaiting_worker phase", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });
      const loop = manager.getLoopState(ORIGIN_SID)!;
      (loop as any).phase = "awaiting_worker";

      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(true);
    });

    it("returns false for unknown, terminal, and origin-owned phases", () => {
      const manager = freshManager();
      expect(manager.shouldCancelOnUserMessage("unknown", "user message")).toBe(false);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });
      const loop = manager.getLoopState(ORIGIN_SID)!;

      (loop as any).phase = "complete";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
      (loop as any).phase = "cancelled";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
      (loop as any).phase = "error";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
      (loop as any).phase = "interrupted";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
      // Origin-owned phases also return false
      (loop as any).phase = "activating";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
      (loop as any).phase = "summarizing";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
      (loop as any).phase = "finalizing";
      expect(manager.shouldCancelOnUserMessage(ORIGIN_SID, "user message")).toBe(false);
    });
  });

  // ── getByActiveSession ──────────────────────────────────────────

  describe("getByActiveSession", () => {
    it("returns undefined for unknown session", () => {
      const manager = freshManager();
      expect(manager.getByActiveSession("nope")).toBeUndefined();
    });

    it("returns loop by child session ID after manual setup", () => {
      const manager = freshManager();
      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Manually set up child state
      const childId = "child-1";
      const loop = manager.getLoopState(ORIGIN_SID)!;
      loop.activeSessionId = childId;
      (manager as any).childToOrigin.set(childId, ORIGIN_SID);

      const found = manager.getByActiveSession(childId);
      expect(found).toBeDefined();
      expect(found!.originSessionId).toBe(ORIGIN_SID);
    });
  });

  // ── requestCancel ────────────────────────────────────────────────

  describe("requestCancel", () => {
    it("sets cancelRequested=true", () => {
      const client = loopMockClient();
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      manager.requestCancel(ORIGIN_SID);

      const loop = manager.getByActiveSession(ORIGIN_SID);
      expect(loop!.cancelRequested).toBe(true);
    });

    it("during waiting status → finalizes to cancelled immediately", () => {
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

  // ── handleSessionError ───────────────────────────────────────────

  describe("handleSessionError", () => {
    it("child error → status=error, origin note injected, child mapping cleared", () => {
      const client = loopMockClient();
      const manager = freshManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      // Manually set up child state
      const childId = "child-1";
      const loop = manager.getLoopState(ORIGIN_SID)!;
      loop.activeSessionId = childId;
      (manager as any).childToOrigin.set(childId, ORIGIN_SID);

      expect(manager.isLoopChild(childId)).toBe(true);

      manager.handleSessionError(childId, "API rate limit exceeded");

      expect(loop.status).toBe("error");
      expect(loop.errorReason).toBe("API rate limit exceeded");

      // Child mapping cleared
      expect(manager.isLoopChild(childId)).toBe(false);

      // Error note injected into origin
      const allCalls = (client.session.promptAsync as any).mock
        .calls as unknown[][];
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

  // ── setStoreDirectory + recover ──────────────────────────────────

  describe("setStoreDirectory + recover", () => {
    it("recover loads persisted loops and marks non-terminal as interrupted", () => {
      const manager = freshManager();

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
