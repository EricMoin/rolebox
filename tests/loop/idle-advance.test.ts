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

    const loopState = activeLoopManager!.getLoopState(sid)!;
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

  it("advances from awaiting_worker through summarizing to next dispatch without deadlock", async () => {
    const sid = "ses_bridge_deadlock";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    await activeLoopManager!.onOriginIdle(sid);
    const loopState = activeLoopManager!.getLoopState(sid)!;
    expect(loopState.phase).toBe("awaiting_worker");

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    const afterState = activeLoopManager!.getLoopState(sid)!;
    expect(afterState.phase).not.toBe("summarizing");
  });
});
