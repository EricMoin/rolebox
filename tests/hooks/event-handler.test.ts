import { describe, it, expect, mock, beforeEach } from "bun:test";
import { handleEvent } from "../../src/hooks/event-handler.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import { functionSessionState } from "../../src/function/session-state.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    client: {} as any,
    session: { messages: mock(() => Promise.resolve([])) } as any,
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {
      handleSessionIdle: mock(() => {}),
      handleSessionStatus: mock(() => {}),
      handleSessionError: mock(() => Promise.resolve()),
      handleSessionDeleted: mock(() => Promise.resolve()),
      handleMessageUpdated: mock(() => {}),
      isSyncSession: mock(() => false),
      getInflightCount: mock(() => 0),
    } as any,
    loopManager: {
      isActiveLoopOrigin: mock(() => false),
      isLoopSession: mock(() => false),
    } as any,
    customHooks: { runHooks: mock(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

function makeState(): HookState {
  return new HookState();
}

function makeEvent(type: string, props?: Record<string, unknown>): any {
  return { type, properties: props ?? {} };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleEvent — hook lifecycle phases", () => {
  it("calls built-in hooks before and after for all event types", async () => {
    const builtInRunHooks = mock(() => Promise.resolve());
    const deps = minimalDeps({ builtInHooks: { runHooks: builtInRunHooks } as any });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    // Called twice: before + after
    expect(builtInRunHooks).toHaveBeenCalled();
    expect(builtInRunHooks.mock.calls[0][0]).toBe("event");
    expect(builtInRunHooks.mock.calls[1][0]).toBe("event");
  });

  it("calls custom hooks before and after for all event types", async () => {
    const customRunHooks = mock(() => Promise.resolve());
    const builtInRunHooks = mock(() => Promise.resolve());
    const deps = minimalDeps({
      customHooks: { runHooks: customRunHooks } as any,
      builtInHooks: { runHooks: builtInRunHooks } as any,
    });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    expect(customRunHooks).toHaveBeenCalled();
    expect(customRunHooks.mock.calls[0][0]).toBe("event");
    expect(customRunHooks.mock.calls[0][1]).toBe("before");
    expect(customRunHooks.mock.calls[1][0]).toBe("event");
    expect(customRunHooks.mock.calls[1][1]).toBe("after");
  });

  it("passes event type and properties to runHooks", async () => {
    const customRunHooks = mock(() => Promise.resolve());
    const deps = minimalDeps({ customHooks: { runHooks: customRunHooks } as any });

    const props = { sessionID: "sess-1", status: "completed" };
    await handleEvent(
      makeEvent("session.status", props),
      makeState(),
      deps,
    );

    expect(customRunHooks.mock.calls[0][3]).toMatchObject({ type: "session.status", properties: props });
  });
});

describe("handleEvent — session.idle", () => {
  it("handles session.idle event without sessionID gracefully", async () => {
    const handleSessionIdle = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleSessionIdle } as any,
    });

    await handleEvent(
      makeEvent("session.idle", {}),
      makeState(),
      deps,
    );

    expect(handleSessionIdle).not.toHaveBeenCalled();
  });

  it("calls dispatchManager.handleSessionIdle for valid sessionID", async () => {
    const handleSessionIdle = mock(() => {});
    const scheduleIdle = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleSessionIdle, isSyncSession: mock(() => false), getInflightCount: mock(() => 0) } as any,
      notificationManager: { scheduleIdle } as any,
    });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    expect(handleSessionIdle).toHaveBeenCalledWith("sess-1");
  });

  it("skips continuation for sync sessions", async () => {
    const isSyncSession = mock(() => true);
    const promptAsync = mock(() => Promise.resolve({ data: undefined, error: undefined }));
    const deps = minimalDeps({
      dispatchManager: { handleSessionIdle: mock(() => {}), isSyncSession, getInflightCount: mock(() => 0) } as any,
      client: { session: { promptAsync } } as any,
    });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it("skips continuation when there are in-flight dispatches", async () => {
    const getInflightCount = mock(() => 2);
    const promptAsync = mock(() => Promise.resolve({ data: undefined, error: undefined }));
    const deps = minimalDeps({
      dispatchManager: { handleSessionIdle: mock(() => {}), isSyncSession: mock(() => false), getInflightCount } as any,
      client: { session: { promptAsync } } as any,
    });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    expect(getInflightCount).toHaveBeenCalledWith("sess-1");
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it("suppresses continuation during loop-owned phases", async () => {
    const getLoopState = mock(() => ({ phase: "summarizing" }));
    const isActiveLoopOrigin = mock(() => true);
    const promptAsync = mock(() => Promise.resolve({ data: undefined, error: undefined }));
    const deps = minimalDeps({
      dispatchManager: { handleSessionIdle: mock(() => {}), isSyncSession: mock(() => false), getInflightCount: mock(() => 0) } as any,
      loopManager: { isActiveLoopOrigin, getLoopState } as any,
      client: { session: { promptAsync } } as any,
    });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it("does not suppress continuation when loop phase is not owned", async () => {
    const getLoopState = mock(() => ({ phase: "awaiting_worker" }));
    const isActiveLoopOrigin = mock(() => true);
    const promptAsync = mock(() => Promise.resolve({ data: undefined, error: undefined }));
    const deps = minimalDeps({
      dispatchManager: { handleSessionIdle: mock(() => {}), isSyncSession: mock(() => false), getInflightCount: mock(() => 0) } as any,
      loopManager: { isActiveLoopOrigin, getLoopState } as any,
      client: { session: { promptAsync } } as any,
    });

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      deps,
    );

    // No active functions, so no continuation expected
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it("rolls back continuationCount when promptAsync fails", async () => {
    const sid = "sess-1";
    const fnName = "test-fn";

    // A function with a continue_until condition that is never satisfied
    const testFn = {
      name: fnName,
      description: "test function",
      content: "test content",
      filePath: "/tmp/test.ts",
      source: "role-local" as any,
      continue_until: "never_satisfied",
    };

    const roleFunctionsMap = new Map();
    roleFunctionsMap.set("test-role", [testFn]);

    // Setup runtime state
    functionRuntime.resetAll();
    const st = functionRuntime.init(sid, fnName, 1);
    st.phase = "active";

    // Setup session state
    functionSessionState.clear(sid);
    functionSessionState.activate(sid, [fnName]);

    // promptAsync rejects
    const promptAsync = mock(() => Promise.reject(new Error("API down")));

    const deps = minimalDeps({
      roleFunctionsMap,
      client: { session: { promptAsync } } as any,
      dispatchManager: {
        handleSessionIdle: mock(() => {}),
        isSyncSession: mock(() => false),
        getInflightCount: mock(() => 0),
      } as any,
    });

    expect(st.continuationCount).toBe(0);

    await handleEvent(
      makeEvent("session.idle", { sessionID: sid }),
      makeState(),
      deps,
    );

    // promptAsync was called
    expect(promptAsync).toHaveBeenCalled();
    // continuationCount was rolled back on failure
    expect(functionRuntime.get(sid, fnName)!.continuationCount).toBe(0);

    // Cleanup
    functionRuntime.resetAll();
    functionSessionState.clear(sid);
  });
});

describe("handleEvent — session.status", () => {
  it("calls dispatchManager.handleSessionStatus with sessionID and status", async () => {
    const handleSessionStatus = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleSessionStatus } as any,
    });

    await handleEvent(
      makeEvent("session.status", { sessionID: "sess-1", status: "completed" }),
      makeState(),
      deps,
    );

    expect(handleSessionStatus).toHaveBeenCalledWith("sess-1", "completed");
  });

  it("handles status as an object with type field", async () => {
    const handleSessionStatus = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleSessionStatus } as any,
    });

    await handleEvent(
      makeEvent("session.status", { sessionID: "sess-1", status: { type: "error" } }),
      makeState(),
      deps,
    );

    expect(handleSessionStatus).toHaveBeenCalledWith("sess-1", "error");
  });

  it("handles missing sessionID gracefully", async () => {
    const handleSessionStatus = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleSessionStatus } as any,
    });

    await handleEvent(
      makeEvent("session.status", { status: "completed" }),
      makeState(),
      deps,
    );

    expect(handleSessionStatus).not.toHaveBeenCalled();
  });
});

describe("handleEvent — session.error", () => {
  it("calls dispatchManager.handleSessionError", async () => {
    const handleSessionError = mock(() => Promise.resolve());
    const deps = minimalDeps({
      dispatchManager: { handleSessionError } as any,
    });

    await handleEvent(
      makeEvent("session.error", { sessionID: "sess-1", error: "Something broke" }),
      makeState(),
      deps,
    );

    expect(handleSessionError).toHaveBeenCalledWith("sess-1", "Something broke");
  });

  it("handles missing sessionID gracefully", async () => {
    const handleSessionError = mock(() => Promise.resolve());
    const deps = minimalDeps({
      dispatchManager: { handleSessionError } as any,
    });

    await handleEvent(
      makeEvent("session.error", { error: "Something broke" }),
      makeState(),
      deps,
    );

    expect(handleSessionError).not.toHaveBeenCalled();
  });
});

describe("handleEvent — session.deleted", () => {
  it("calls dispatchManager.handleSessionDeleted", async () => {
    const handleSessionDeleted = mock(() => Promise.resolve());
    const handleSessionDeletedNotification = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleSessionDeleted } as any,
      notificationManager: { handleSessionDeleted: handleSessionDeletedNotification } as any,
    });

    await handleEvent(
      makeEvent("session.deleted", { info: { id: "sess-1" } }),
      makeState(),
      deps,
    );

    expect(handleSessionDeleted).toHaveBeenCalledWith("sess-1");
  });

  it("handles missing info gracefully", async () => {
    const handleSessionDeleted = mock(() => Promise.resolve());
    const deps = minimalDeps({
      dispatchManager: { handleSessionDeleted } as any,
    });

    await handleEvent(
      makeEvent("session.deleted", {}),
      makeState(),
      deps,
    );

    expect(handleSessionDeleted).not.toHaveBeenCalled();
  });
});

describe("handleEvent — message.updated", () => {
  it("calls dispatchManager.handleMessageUpdated", async () => {
    const handleMessageUpdated = mock(() => {});
    const handleMessageUpdatedNotification = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleMessageUpdated } as any,
      notificationManager: { handleMessageUpdated: handleMessageUpdatedNotification } as any,
    });

    await handleEvent(
      makeEvent("message.updated", { info: { sessionID: "sess-1" } }),
      makeState(),
      deps,
    );

    expect(handleMessageUpdated).toHaveBeenCalledWith("sess-1");
  });

  it("handles missing info gracefully", async () => {
    const handleMessageUpdated = mock(() => {});
    const deps = minimalDeps({
      dispatchManager: { handleMessageUpdated } as any,
    });

    await handleEvent(
      makeEvent("message.updated", {}),
      makeState(),
      deps,
    );

    expect(handleMessageUpdated).not.toHaveBeenCalled();
  });
});

describe("handleEvent — unhandled event types", () => {
  it("does not crash on unknown event types", async () => {
    const deps = minimalDeps();

    await handleEvent(
      makeEvent("unknown.event.type", { someData: "value" }),
      makeState(),
      deps,
    );

    // Should not crash — unknown events are a no-op beyond hook phases
  });
});

describe("handleEvent — registration/unregister pattern", () => {
  it("calls builtInHooks.runHooks for registration check", async () => {
    const builtInRunHooks = mock(() => Promise.resolve());

    await handleEvent(
      makeEvent("session.idle", { sessionID: "sess-1" }),
      makeState(),
      minimalDeps({
        builtInHooks: { runHooks: builtInRunHooks } as any,
        dispatchManager: { handleSessionIdle: mock(() => {}), isSyncSession: mock(() => false), getInflightCount: mock(() => 0) } as any,
      }),
    );

    // Before phase
    expect(builtInRunHooks.mock.calls[0][0]).toBe("event");
    expect(builtInRunHooks.mock.calls[0][1]).toBe("before");
    // After phase
    expect(builtInRunHooks.mock.calls[1][0]).toBe("event");
    expect(builtInRunHooks.mock.calls[1][1]).toBe("after");
  });
});
