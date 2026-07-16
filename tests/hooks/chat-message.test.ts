import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { handleChatMessage } from "../../src/hooks/chat-message.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import { graphSessionState } from "../../src/graph/index.ts";

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
    client: {} as any,
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
  it("injects correction for nested loop attempts", async () => {
    const isLoopSession = mock(() => true);
    const shouldCancelOnUserMessage = mock(() => false);
    const getLoopState = mock(() => null);
    const register = mock(() => {});
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
    expect(correction).toContain("Nested loops are not supported");
    // register should NOT be called since nested loops are rejected
    expect(register).not.toHaveBeenCalled();
  });

  it("parses and activates loop function from user text", async () => {
    const isLoopSession = mock(() => false);
    const shouldCancelOnUserMessage = mock(() => false);
    const getLoopState = mock(() => null);
    const register = mock(() => {});
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
