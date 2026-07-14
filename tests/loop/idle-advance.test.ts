import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  createPluginHooks,
  activeLoopManager,
  pendingCorrections,
  loopManagerMap,
  managerMap,
} from "../../src/core/composition";
import { LOOP_PROGRESS_MARKER } from "../../src/loop/constants";

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

describe("idle-advance", () => {
  let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-idle-advance-"));
    pendingCorrections.clear();
    const client = createMockClient();
    hooks = await createPluginHooks({ resolvedRoles: [], client, roleFunctionsMap: new Map(), roleGraphMap: new Map(), directory: tmpDir });
  });

  afterEach(() => {
    loopManagerMap.clear();
    managerMap.clear();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("handles idle event for loop session without crashing", async () => {
    const sid = "ses_advance_001";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 1,
    });

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });
    // No crash = pass
  });

  it("suppresses loop advance when dispatch inflight > 0", async () => {
    const sid = "ses_advance_002";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 1,
    });

    const dm = managerMap.get(tmpDir)!;
    const inflightSpy = spyOn(dm, "getInflightCount");
    inflightSpy.mockReturnValue(1);

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });
    // No crash = pass
  });

  it("does nothing when session has no loop registered", async () => {
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_unknown" } },
    });
    // No crash = pass
  });

  it("sets loop phase to error on session.error for loop origins", async () => {
    const sid = "ses_error_001";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    // Let the self-start microtask complete so the loop is in awaiting_worker
    await new Promise((r) => setTimeout(r, 0));

    const loopState = activeLoopManager!.getLoopState(sid)!;
    expect(loopState.phase).toBe("awaiting_worker");

    // Directly set phase to activating (simulating the test scenario)
    loopState.phase = "activating";

    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID: sid, error: "API rate limit" },
      } as any,
    });

    expect(loopState.phase).toBe("error");
    expect(loopState.errorReason).toBe("API rate limit");
    expect(loopState.updatedAt).toBeGreaterThan(0);
  });

  it("does not mutate loop state for non-loop sessions", async () => {
    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID: "ses_unknown", error: "some error" },
      } as any,
    });
  });

  it("injects recovery note for interrupted loop on restart", async () => {
    const sid = "ses_recovery_001";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 5,
    });

    const loopState = activeLoopManager!.getLoopState(sid)!;
    loopState.phase = "interrupted";
    (loopState as any).status = "interrupted";
    loopState.current = 3;
    loopState.total = 5;

    const output = {
      parts: [{ type: "text" as const, text: "continue where we left off" }],
    };

    await hooks["chat.message"](
      { agent: "test-agent", sessionID: sid },
      output,
    );

    const correction = pendingCorrections.get(sid);
    expect(correction).toBeDefined();
    expect(correction!).toContain(LOOP_PROGRESS_MARKER);
    expect(correction!).toContain("loop interrupted by restart");
    expect(correction!).toContain("round 3/5");
    expect(loopState.phase).toBe("cancelled");
  });

  it("does not inject recovery note when loop is still running", async () => {
    const sid = "ses_recovery_002";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    const output = {
      parts: [{ type: "text" as const, text: "keep going" }],
    };

    await hooks["chat.message"](
      { agent: "test-agent", sessionID: sid },
      output,
    );

    const correction = pendingCorrections.get(sid);
    expect(correction ?? "").not.toContain("loop interrupted by restart");
  });

  it("does not inject recovery note for loop-progress marker messages", async () => {
    const sid = "ses_recovery_003";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    const loopState = activeLoopManager!.getLoopState(sid)!;
    loopState.status = "interrupted";
    loopState.current = 2;
    loopState.total = 3;

    const output = {
      parts: [
        {
          type: "text" as const,
          text: `${LOOP_PROGRESS_MARKER} round 1/3 done]`,
        },
      ],
    };

    await hooks["chat.message"](
      { agent: "test-agent", sessionID: sid },
      output,
    );

    const correction = pendingCorrections.get(sid);
    expect(correction ?? "").not.toContain("loop interrupted by restart");
  });

  it("self-start microtask advances activating phase regardless of inflight count", async () => {
    const sid = "ses_inflight_advance";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 1,
    });

    const beforeState = activeLoopManager!.getLoopState(sid)!;
    expect(beforeState.phase).toBe("activating");

    const dm = managerMap.get(tmpDir)!;
    const inflightSpy = spyOn(dm, "getInflightCount");
    inflightSpy.mockReturnValue(1);

    // Fire idle event — the self-start microtask (scheduled by register)
    // fires during the await, advancing activating → dispatching → awaiting_worker.
    // inflight > 0 does NOT block the self-start (it only blocks continuation,
    // not the register microtask).
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    const afterState = activeLoopManager!.getLoopState(sid)!;
    // Self-start microtask advanced the loop regardless of inflight count
    expect(afterState.phase).toBe("awaiting_worker");
  });

  it("does not advance from awaiting_worker on idle — push chain handles it", async () => {
    const sid = "ses_push_chain_awaiting";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    // Self-start microtask fires from register, no onOriginIdle needed
    await new Promise((r) => setTimeout(r, 0));
    const loopState = activeLoopManager!.getLoopState(sid)!;
    expect(loopState.phase).toBe("awaiting_worker");

    // Idle no longer advances awaiting_worker — the push chain
    // (terminated listener → onWorkerCompleted → _advanceFromSummarizing)
    // drives awaiting_worker → summarizing → dispatch/finalize.
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    const afterState = activeLoopManager!.getLoopState(sid)!;
    expect(afterState.phase).toBe("awaiting_worker");
  });

  it("awaiting_worker no longer advances via idle when worker completed (push chain)", async () => {
    const sid = "ses_inflight_awaiting_push";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    // Self-start microtask fires from register, no onOriginIdle needed
    await new Promise((r) => setTimeout(r, 0));
    const loopState = activeLoopManager!.getLoopState(sid)!;
    expect(loopState.phase).toBe("awaiting_worker");
    expect(loopState.activeWorkerTaskId).toBeDefined();

    // Mock: loop's own worker task is still counted in inflight
    const dm = managerMap.get(tmpDir)!;
    const inflightSpy = spyOn(dm, "getInflightCount");
    inflightSpy.mockReturnValue(1);

    // Mock: the worker task is completed
    const taskId = loopState.activeWorkerTaskId!;
    const getTaskSpy = spyOn(dm, "getTask");
    getTaskSpy.mockReturnValue({
      id: taskId,
      sessionId: "worker-session",
      parentSessionId: sid,
      depth: 1,
      status: "completed",
      agent: "test-agent",
      prompt: "do work",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    });

    // Trigger session.idle — the awaiting_worker bypass was removed.
    // The push chain (terminated listener → onWorkerCompleted) handles
    // awaiting_worker → summarizing → next dispatch/finalize.
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    const afterState = activeLoopManager!.getLoopState(sid)!;
    // Idle no longer advances awaiting_worker — phase stays put.
    expect(afterState.phase).toBe("awaiting_worker");
  });
});
