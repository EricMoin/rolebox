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
} from "../../src/plugin-hooks";
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
    hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);
  });

  afterEach(() => {
    loopManagerMap.clear();
    managerMap.clear();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  // ── session.idle: empty activeSet + loop running → advance ──────
  it("advances loop when activeSet is empty and loop is running", async () => {
    const sid = "ses_advance_001";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 1,
    });

    const advanceSpy = spyOn(activeLoopManager!, "onRoundComplete");

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    expect(advanceSpy).toHaveBeenCalledWith(sid);
  });

  // ── session.idle: empty activeSet + inflight > 0 → suppress ─────
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
    // Return 0 for the first check (inflight guard before continuation),
    // but 1 for the second check (inside empty activeSet block).
    // Actually, since activeSet is empty, we take the early break path
    // which only has one inflight check. Return 1 there.
    inflightSpy.mockReturnValue(1);

    const advanceSpy = spyOn(activeLoopManager!, "onRoundComplete");

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    expect(advanceSpy).not.toHaveBeenCalled();
  });

  // ── session.idle: empty activeSet + loop not running → suppress ──
  it("suppresses loop advance when loop status is not running", async () => {
    const sid = "ses_advance_003";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 1,
    });

    // Manually set status to error
    const loop = activeLoopManager!.getByActiveSession(sid)!;
    loop.status = "error";

    const advanceSpy = spyOn(activeLoopManager!, "onRoundComplete");

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sid } },
    });

    expect(advanceSpy).not.toHaveBeenCalled();
  });

  // ── session.idle: no loop for session → no-op ────────────────────
  it("does nothing when session has no loop registered", async () => {
    const advanceSpy = spyOn(activeLoopManager!, "onRoundComplete");

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_unknown" } },
    });

    expect(advanceSpy).not.toHaveBeenCalled();
  });

  // ── session.error: loop session → handleSessionError ──────────────
  it("routes session.error to loopManager.handleSessionError for loop sessions", async () => {
    const sid = "ses_error_001";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 3,
    });

    const errorSpy = spyOn(activeLoopManager!, "handleSessionError");

    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID: sid, error: "API rate limit" },
      } as any,
    });

    expect(errorSpy).toHaveBeenCalledWith(sid, "API rate limit");
  });

  // ── session.error: non-loop session → no loop error routing ──────
  it("does not route session.error to loopManager for non-loop sessions", async () => {
    const errorSpy = spyOn(activeLoopManager!, "handleSessionError");

    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID: "ses_unknown", error: "some error" },
      } as any,
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ── chat.message: recovery note on interrupted loop ──────────────
  it("injects recovery note for interrupted loop on restart", async () => {
    const sid = "ses_recovery_001";
    activeLoopManager!.register({
      originSessionId: sid,
      agent: "test-agent",
      prompt: "do work",
      mode: "fresh",
      iterations: 5,
    });

    // Simulate loop state after a restart: status was "interrupted"
    const loopState = activeLoopManager!.getLoopState(sid)!;
    loopState.status = "interrupted";
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
    expect(loopState.status).toBe("cancelled");
  });

  // ── chat.message: no recovery note for running loops ─────────────
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
    // Should be undefined or not contain recovery note
    expect(correction ?? "").not.toContain("loop interrupted by restart");
  });

  // ── chat.message: no recovery note on loop-progress injection ────
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

    // Loop-progress messages should NOT trigger recovery notes
    const correction = pendingCorrections.get(sid);
    expect(correction ?? "").not.toContain("loop interrupted by restart");
  });
});
