import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { handleChatMessage } from "../../src/hooks/chat-message.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import { graphSessionState } from "../../src/graph/collaboration-state.ts";
import { GRAPH_COMPLETE_MARKER, GRAPH_BLOCKED_MARKER, isDispatchNotification } from "../../src/dispatch/notification.ts";
import { COPILOT_MARKER } from "../../src/copilot/constants.ts";

// ── Cleanup between tests ───────────────────────────────────────────────────

beforeEach(() => {
  functionSessionState.clear("sess-1");
  functionSessionState.clear("sess-2");
  functionRuntime.clearSession("sess-1");
  functionRuntime.clearSession("sess-2");
  graphSessionState.clear("sess-1");
  graphSessionState.clear("sess-2");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: { messages: mock(() => Promise.resolve([])) } as any,
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {} as any,
    loopManager: {} as any,
    customHooks: { runHooks: mock(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

function makeTextOutput(text: string) {
  return { parts: [{ type: "text", text }] };
}

function makeState(): HookState {
  return new HookState();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleChatMessage — before/after hook phases", () => {
  it("calls built-in hooks in before and after phases", async () => {
    const builtInRunHooks = mock(() => Promise.resolve());
    const customRunHooks = mock(() => Promise.resolve());

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("hello"),
      makeState(),
      minimalDeps({
        builtInHooks: { runHooks: builtInRunHooks } as any,
        customHooks: { runHooks: customRunHooks } as any,
      }),
    );

    // Built-in: before and after (2 calls)
    expect(builtInRunHooks).toHaveBeenCalledTimes(2);
    expect(builtInRunHooks.mock.calls[0][1]).toBe("before");
    expect(builtInRunHooks.mock.calls[1][1]).toBe("after");
  });

  it("calls custom hooks in before and after phases", async () => {
    const customRunHooks = mock(() => Promise.resolve());

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("hello"),
      makeState(),
      minimalDeps({ customHooks: { runHooks: customRunHooks } as any }),
    );

    // Custom: before and after (2 calls)
    expect(customRunHooks).toHaveBeenCalledTimes(2);
    expect(customRunHooks.mock.calls[0][1]).toBe("before");
    expect(customRunHooks.mock.calls[1][1]).toBe("after");
  });

  it("passes correct event and input to runHooks", async () => {
    const customRunHooks = mock(() => Promise.resolve());

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("hello"),
      makeState(),
      minimalDeps({ customHooks: { runHooks: customRunHooks } as any }),
    );

    expect(customRunHooks.mock.calls[0][0]).toBe("chat.message");
    expect(customRunHooks.mock.calls[0][3]).toMatchObject({ text: "hello" });
  });
});

describe("handleChatMessage — synthetic injection filtering", () => {
  it("does NOT register in userMessagedSessions for auto-continue messages", async () => {
    const state = makeState();

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("[auto-continue] check status"),
      state,
      minimalDeps(),
    );

    expect(state.userMessagedSessions.has("sess-1")).toBe(false);
  });

  it("does NOT register in userMessagedSessions for loop progress messages", async () => {
    const state = makeState();

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("[loop-progress round 2/5]"),
      state,
      minimalDeps(),
    );

    expect(state.userMessagedSessions.has("sess-1")).toBe(false);
  });

  it("classifies COPILOT_MARKER messages as synthetic injection", async () => {
    const cancelNow = mock(() => Promise.resolve());
    const shouldCancelOnUserMessage = mock(() => true);
    const state = makeState();
    state.activeLoopManager = {
      shouldCancelOnUserMessage,
      cancelNow,
      isLoopSession: mock(() => false),
      getLoopState: mock(() => null),
      register: mock(() => {}),
    } as any;

    // Activate a function with a non-zero continuation counter.
    functionSessionState.activate("sess-1", ["synthesize"]);
    const st = functionRuntime.init("sess-1", "synthesize", 1);
    st.continuationCount = 2;
    st.cooldownUntilTurn = 7;

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput(`${COPILOT_MARKER} pi] continue the task`),
      state,
      minimalDeps(),
    );

    // Continuation counter NOT reset — synthetic injection must not defeat the
    // builtin continuation caps (unbounded auto-continue spin).
    expect(st.continuationCount).toBe(2);
    expect(st.cooldownUntilTurn).toBe(7);
    // Session NOT registered as user-messaged.
    expect(state.userMessagedSessions.has("sess-1")).toBe(false);
    // Loops NOT cancelled.
    expect(shouldCancelOnUserMessage).not.toHaveBeenCalled();
    expect(cancelNow).not.toHaveBeenCalled();
  });

  it("registers real user messages in userMessagedSessions", async () => {
    const state = makeState();
    const notificationManager = { handleChatMessage: mock(() => {}) };

    await handleChatMessage(
      { sessionID: "sess-1" },
      makeTextOutput("real user message"),
      state,
      minimalDeps({ notificationManager: notificationManager as any }),
    );

    expect(state.userMessagedSessions.has("sess-1")).toBe(true);
    expect(notificationManager.handleChatMessage).toHaveBeenCalledWith("sess-1", undefined);
  });
});

describe("handleChatMessage — session agent registration", () => {
  it("registers session->agent mapping when agent is provided", async () => {
    const state = makeState();

    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("hello"),
      state,
      minimalDeps(),
    );

    expect(state.sessionAgentRegistry.get("sess-1")).toBe("agent-alpha");
  });

  it("does not register mapping when agent is missing", async () => {
    const state = makeState();

    await handleChatMessage(
      { sessionID: "sess-1" },
      makeTextOutput("hello"),
      state,
      minimalDeps(),
    );

    expect(state.sessionAgentRegistry.has("sess-1")).toBe(false);
  });

  it("does not overwrite session->agent mapping for synthetic (reminder) injections", async () => {
    const state = makeState();
    // A genuine user turn already bound this session to a real role.
    state.sessionAgentRegistry.set("sess-1", "emperor--jinyiwei");

    // A graph-terminal <system-reminder> re-enters; before fix [2] the platform
    // default agent (no forwarded role) overwrote the registry, so
    // system.transform later resolved the wrong role.
    await handleChatMessage(
      { agent: "default_agent", sessionID: "sess-1" },
      makeTextOutput(`${GRAPH_COMPLETE_MARKER} graph complete`),
      state,
      minimalDeps(),
    );

    // Registry must retain the genuine role — synthetic injections are dead
    // turns, not a change of acting role.
    expect(state.sessionAgentRegistry.get("sess-1")).toBe("emperor--jinyiwei");
  });
});

describe("handleChatMessage — auto-activation", () => {
  it("auto-activates functions from roleAutoActivateMap", async () => {
    const state = makeState();
    state.roleAutoActivateMap.set("agent-alpha", ["fn1", "fn2"]);
    state.roleLockedMap.set("agent-alpha", true);

    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("hello"),
      state,
      minimalDeps(),
    );

    expect(state.autoActivatedSessions.has("sess-1")).toBe(true);
  });

  it("does not auto-activate twice for the same session", async () => {
    const state = makeState();
    state.roleAutoActivateMap.set("agent-alpha", ["fn1"]);
    state.autoActivatedSessions.add("sess-1");

    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("hello"),
      state,
      minimalDeps(),
    );

    // Should not double-activate
    expect(state.autoActivatedSessions.has("sess-1")).toBe(true);
  });
});

describe("handleChatMessage — function parsing and activation", () => {
  it("parses function calls from text and activates them", async () => {
    const state = makeState();

    // Function parser requires |fn| at the start of a line
    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("|bash|\nrun this command"),
      state,
      minimalDeps({
        roleFunctionsMap: new Map([["agent-alpha", [{ name: "bash" } as any]]]),
      }),
    );

    // Function "bash" should be activated
    const active = functionSessionState.getActive("sess-1");
    expect(active.has("bash")).toBe(true);
  });

  it("strips function call syntax from the output text", async () => {
    const state = makeState();
    const output = makeTextOutput("|read|\ncheck the file");

    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      output,
      state,
      minimalDeps({
        roleFunctionsMap: new Map([["agent-alpha", [{ name: "read" } as any]]]),
      }),
    );

    const textPart = output.parts.find((p: any) => p.type === "text") as any;
    expect(textPart.text).not.toContain("|read|");
  });

  it("filters activation to valid role functions when roleFunctionsMap has entries", async () => {
    const state = makeState();

    // Function names must match /^[a-z][a-z0-9-]*$/ — underscores are NOT valid
    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("|valid|\ncontent"),
      state,
      minimalDeps({
        roleFunctionsMap: new Map([["agent-alpha", [{ name: "valid" } as any]]]),
      }),
    );

    const active = functionSessionState.getActive("sess-1");
    expect(active.has("valid")).toBe(true);
  });
});

describe("handleChatMessage — loop cancellation", () => {
  it("cancels loop when user message triggers cancellation", async () => {
    const cancelNow = mock(() => Promise.resolve());
    const shouldCancelOnUserMessage = mock(() => true);
    const getLoopState = mock(() => null);
    const register = mock(() => {});
    const state = makeState();
    state.activeLoopManager = {
      shouldCancelOnUserMessage,
      cancelNow,
      isLoopSession: mock(() => false),
      getLoopState,
      register,
    } as any;

    await handleChatMessage(
      { sessionID: "sess-1" },
      makeTextOutput("stop the loop"),
      state,
      minimalDeps(),
    );

    expect(shouldCancelOnUserMessage).toHaveBeenCalledWith("sess-1", "stop the loop");
    expect(cancelNow).toHaveBeenCalledWith("sess-1");
  });

  it("does not cancel when shouldCancelOnUserMessage returns false", async () => {
    const cancelNow = mock(() => Promise.resolve());
    const shouldCancelOnUserMessage = mock(() => false);
    const getLoopState = mock(() => null);
    const register = mock(() => {});
    const state = makeState();
    state.activeLoopManager = {
      shouldCancelOnUserMessage,
      cancelNow,
      isLoopSession: mock(() => false),
      getLoopState,
      register,
    } as any;

    await handleChatMessage(
      { sessionID: "sess-1" },
      makeTextOutput("continue the loop"),
      state,
      minimalDeps(),
    );

    expect(cancelNow).not.toHaveBeenCalled();
  });
});

describe("handleChatMessage — loop function activation", () => {
  it("injects correction when loop registration is rejected (nested/same-origin)", async () => {
    // Nested-loop rejection now happens inside coordinator.register, which
    // returns a RegisterResult. The hook surfaces the rejection as a correction.
    const isLoopSession = mock(() => true);
    const shouldCancelOnUserMessage = mock(() => false);
    const getLoopState = mock(() => null);
    const register = mock(() => ({
      ok: false,
      reason: "loop already active for this session",
    }));
    const state = makeState();
    state.activeLoopManager = {
      isLoopSession,
      getLoopState,
      shouldCancelOnUserMessage,
      register,
    } as any;

    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("|loop|\n do something"),
      state,
      minimalDeps(),
    );

    const correction = state.pendingCorrections.get("sess-1");
    expect(correction).toContain("Loop not started: loop already active for this session");
    // register is invoked and its rejection is surfaced to the agent
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("parses and activates loop function from user text", async () => {
    const isLoopSession = mock(() => false);
    const shouldCancelOnUserMessage = mock(() => false);
    const getLoopState = mock(() => null);
    const register = mock(() => ({ ok: true }));
    const state = makeState();
    state.activeLoopManager = {
      isLoopSession,
      getLoopState,
      shouldCancelOnUserMessage,
      register,
    } as any;

    await handleChatMessage(
      { agent: "agent-alpha", sessionID: "sess-1" },
      makeTextOutput("|loop|\n do something"),
      state,
      minimalDeps(),
    );

    // Loop function is parsed and activated
    const active = functionSessionState.getActive("sess-1");
    expect(active.has("loop")).toBe(true);
  });
});

describe("handleChatMessage — text part extraction", () => {
  it("handles output with no text parts gracefully", async () => {
    const state = makeState();
    const output = { parts: [{ type: "tool_use", name: "bash" }] };

    await handleChatMessage(
      { sessionID: "sess-1" },
      output as any,
      state,
      minimalDeps(),
    );

    // Should not crash and firstText should be empty string
    expect(state.userMessagedSessions.has("sess-1")).toBe(true);
  });

  it("handles empty text part", async () => {
    const state = makeState();

    await handleChatMessage(
      { sessionID: "sess-1", agent: "test-agent" },
      makeTextOutput(""),
      state,
      minimalDeps(),
    );

    // Empty text should still be registered as user message
    expect(state.userMessagedSessions.has("sess-1")).toBe(true);
  });
});

describe("handleChatMessage — wake-event clear for gated functions", () => {
  it("resets gated functions to active when a [GRAPH COMPLETE] message arrives", async () => {
    const state = makeState();
    functionSessionState.activate("sess-1", ["plan"]);
    const st = functionRuntime.init("sess-1", "plan", 1);
    st.phase = "gated";
    st.evidenceObserved["paused"] = true;

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput(GRAPH_COMPLETE_MARKER),
      state,
      minimalDeps(),
    );

    expect(st.phase).toBe("active");
    expect(st.evidenceObserved["paused"]).toBe(false);
  });

  it("resets gated functions to active when a [HITL APPROVAL REQUIRED] message arrives", async () => {
    const state = makeState();
    functionSessionState.activate("sess-1", ["plan"]);
    const st = functionRuntime.init("sess-1", "plan", 1);
    st.phase = "gated";
    st.evidenceObserved["paused"] = true;

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("<system-reminder>\n[HITL APPROVAL REQUIRED]\n**Task ID:** t1\n</system-reminder>"),
      state,
      minimalDeps(),
    );

    expect(st.phase).toBe("active");
    expect(st.evidenceObserved["paused"]).toBe(false);
  });

  it("does NOT reset gated functions for auto-continue messages", async () => {
    const state = makeState();
    functionSessionState.activate("sess-1", ["plan"]);
    const st = functionRuntime.init("sess-1", "plan", 1);
    st.phase = "gated";
    st.evidenceObserved["paused"] = true;

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("[auto-continue] check status (1/3)"),
      state,
      minimalDeps(),
    );

    expect(st.phase).toBe("gated");
    expect(st.evidenceObserved["paused"]).toBe(true);
  });

  it("dispatch-notification markers reset blocked state; auto-continue markers do NOT", async () => {
    // GRAPH_COMPLETE resets
    functionSessionState.activate("sess-1", ["plan"]);
    const st1 = functionRuntime.init("sess-1", "plan", 1);
    st1.phase = "gated";
    st1.evidenceObserved["paused"] = true;

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput(GRAPH_COMPLETE_MARKER),
      makeState(),
      minimalDeps(),
    );

    expect(st1.phase).toBe("active");
    expect(st1.evidenceObserved["paused"]).toBe(false);

    // Clean up and test GRAPH_BLOCKED resets
    functionSessionState.clear("sess-2");
    functionRuntime.clearSession("sess-2");
    functionSessionState.activate("sess-2", ["execute"]);
    const st2 = functionRuntime.init("sess-2", "execute", 1);
    st2.phase = "gated";
    st2.evidenceObserved["paused"] = true;

    await handleChatMessage(
      { agent: "other-agent", sessionID: "sess-2" },
      makeTextOutput(GRAPH_BLOCKED_MARKER),
      makeState(),
      minimalDeps(),
    );

    expect(st2.phase).toBe("active");
    expect(st2.evidenceObserved["paused"]).toBe(false);

    // Clean up and verify auto-continue does NOT reset
    functionSessionState.clear("sess-1");
    functionRuntime.clearSession("sess-1");
    functionSessionState.activate("sess-1", ["report"]);
    const st3 = functionRuntime.init("sess-1", "report", 1);
    st3.phase = "gated";
    st3.evidenceObserved["paused"] = true;

    await handleChatMessage(
      { agent: "test-agent", sessionID: "sess-1" },
      makeTextOutput("[auto-continue] reminder (2/5)"),
      makeState(),
      minimalDeps(),
    );

    expect(st3.phase).toBe("gated");
    expect(st3.evidenceObserved["paused"]).toBe(true);
  });
});
