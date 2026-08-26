/**
 * Pi chat-message activation tests (subtask S8).
 *
 * Verifies `src/platform/adapters/pi/chat-activation.ts` — the wiring that
 * detects user messages on Pi and runs the shared opencode `handleChatMessage`
 * pipeline (src/hooks/chat-message.ts) with the S6 hook pipeline's
 * state/deps:
 *
 *   1. A `message_start` event whose `message.role === "user"` and whose
 *      content carries a `|fn|` activation call activates the function in
 *      `functionSessionState`.
 *   2. A role with `auto_activate` activates its defaults on the FIRST user
 *      message (and only once per session).
 *   3. A `[HITL APPROVAL REQUIRED]` wake message unblocks a gated function
 *      (`phase: "gated"` → `"active"`).
 *   4. JSONL fallback: when the event does not identify a user message
 *      (legacy Pi / resumed session), the LAST user message of the invoking
 *      session is replayed through the pipeline (state restoration), with
 *      per-session dedup and synthetic-injection skipping exactly as
 *      chat-message.ts:26-29.
 *   5. `wirePiChatActivation` subscribes `pi.on("message_start")` and
 *      degrades gracefully when the Pi API lacks `.on()`.
 *
 * @module
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runPiChatActivation,
  wirePiChatActivation,
  resetPiChatActivationDedup,
} from "../src/platform/adapters/pi/chat-activation.ts";
import { HookState } from "../src/hooks/state.ts";
import type { HookDeps } from "../src/hooks/deps.ts";
import type { ResolvedFunction, ResolvedRole } from "../src/types.ts";
import { functionSessionState } from "../src/function/session-state.ts";
import { functionRuntime } from "../src/function/runtime-state.ts";
import { graphSessionState } from "../src/graph/collaboration-state.ts";
import { COPILOT_MARKER } from "../src/copilot/constants.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SID = "sess-act";

function makeFn(
  name: string,
  overrides?: Partial<ResolvedFunction>,
): ResolvedFunction {
  return {
    name,
    description: `${name} description`,
    content: `${name} content`,
    filePath: `/tmp/${name}.ts`,
    source: "role-local",
    ...overrides,
  };
}

function makeRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: "agent-a",
    config: { name: "Agent A", description: "A", prompt: "You are A." },
    prompt: "You are A.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  };
}

interface DepsFixture {
  runHooks: ReturnType<typeof mock>;
  messages: ReturnType<typeof mock>;
}

/** Minimal HookDeps with observable customHooks + session.messages spies. */
function makeDeps(
  dir: string,
  overrides?: Partial<HookDeps>,
): HookDeps & { __fixture: DepsFixture } {
  const runHooks = mock(() => Promise.resolve());
  const messages = mock(() => Promise.resolve([]));
  const deps = {
    session: { messages } as never,
    roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
    roleGraphMap: new Map(),
    roleMap: new Map<string, ResolvedRole>(),
    dir,
    dispatchManager: {} as never,
    loopManager: {} as never,
    customHooks: { runHooks } as never,
    ...overrides,
  } as HookDeps & { __fixture: DepsFixture };
  (deps as { __fixture: DepsFixture }).__fixture = { runHooks, messages };
  return deps;
}

/** Count pipeline invocations: handleChatMessage runs before+after custom hooks. */
function pipelineRuns(deps: HookDeps & { __fixture: DepsFixture }): number {
  return deps.__fixture.runHooks.mock.calls.length / 2;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-chat-activation-"));
  functionSessionState.clear(SID);
  graphSessionState.clear(SID);
  resetPiChatActivationDedup();
});

afterEach(() => {
  functionRuntime.resetAll();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. User message with an activation call ─────────────────────────────────

describe("runPiChatActivation — user message activation", () => {
  it("activates the function when a user message carries a |fn| call", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("review")]]]),
    });

    const result = await runPiChatActivation(
      {
        type: "message_start",
        sessionID: SID,
        messageID: "msg-1",
        message: { role: "user", content: "|review| check this" },
      },
      { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(true);
    expect(functionSessionState.getActive(SID).has("review")).toBe(true);
    expect(functionSessionState.getActive(SID).has("other")).toBe(false);
  });

  it("strips the activation call and still marks the session as user-messaged", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("read")]]]),
    });
    const state = new HookState();

    await runPiChatActivation(
      {
        type: "message_start",
        sessionID: SID,
        messageID: "msg-2",
        message: { role: "user", content: "|read| check the file" },
      },
      { state, deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(functionSessionState.getActive(SID).has("read")).toBe(true);
    expect(state.userMessagedSessions.has(SID)).toBe(true);
  });

  it("does not double-process a re-emitted user message (dedup by message id)", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("review")]]]),
    });
    const event = {
      type: "message_start",
      sessionID: SID,
      messageID: "msg-same",
      message: { role: "user", content: "|review| once" },
    };

    const first = await runPiChatActivation(event, {
      state: new HookState(),
      deps,
      activeAgent: { get: () => "agent-a" },
    });
    const second = await runPiChatActivation(event, {
      state: new HookState(),
      deps,
      activeAgent: { get: () => "agent-a" },
    });

    expect(first.processed).toBe(true);
    expect(second.processed).toBe(false);
    expect(pipelineRuns(deps)).toBe(1);
  });
});

// ── 2. Auto-activation on first user message ────────────────────────────────

describe("runPiChatActivation — auto-activation", () => {
  it("activates auto_activate defaults on the FIRST user message", async () => {
    const state = new HookState();
    state.roleAutoActivateMap.set("agent-a", ["guard-fn"]);
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("guard-fn")]]]),
    });

    const result = await runPiChatActivation(
      {
        type: "message_start",
        sessionID: SID,
        messageID: "msg-auto",
        message: { role: "user", content: "hello" },
      },
      { state, deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(true);
    // Defaults activated into functionSessionState.
    expect(functionSessionState.getActive(SID).has("guard-fn")).toBe(true);
    // Only once per session.
    expect(state.autoActivatedSessions.has(SID)).toBe(true);
    // Runtime state initialized for the auto-activated function.
    expect(functionRuntime.get(SID, "guard-fn")).toBeDefined();
  });

  it("does not re-run auto-activation on later user messages", async () => {
    const state = new HookState();
    state.roleAutoActivateMap.set("agent-a", ["guard-fn"]);
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("guard-fn")]]]),
    });
    const base = {
      type: "message_start",
      sessionID: SID,
      message: { role: "user" as const, content: "hello" },
    };

    await runPiChatActivation({ ...base, messageID: "a1" }, { state, deps, activeAgent: { get: () => "agent-a" } });
    await runPiChatActivation({ ...base, messageID: "a2", message: { role: "user", content: "again" } }, { state, deps, activeAgent: { get: () => "agent-a" } });

    // autoActivatedSessions still holds — activation happened exactly once.
    expect(state.autoActivatedSessions.has(SID)).toBe(true);
    expect(functionSessionState.getActive(SID).has("guard-fn")).toBe(true);
  });
});

// ── 3. Wake-event unblocking for gated functions ────────────────────────────

describe("runPiChatActivation — wake-event unblocking", () => {
  it("unblocks a gated function on a [HITL APPROVAL REQUIRED] wake message", async () => {
    const state = new HookState();
    functionSessionState.activate(SID, ["plan"]);
    const st = functionRuntime.init(SID, "plan", 1);
    st.phase = "gated";
    st.evidenceObserved["paused"] = true;

    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("plan")]]]),
    });

    const result = await runPiChatActivation(
      {
        type: "message_start",
        sessionID: SID,
        messageID: "msg-wake",
        message: {
          role: "user",
          content: "<system-reminder>\n[HITL APPROVAL REQUIRED]\n**Task ID:** t1\n</system-reminder>",
        },
      },
      { state, deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(true);
    expect(functionRuntime.get(SID, "plan")!.phase).toBe("active");
    expect(st.evidenceObserved["paused"]).toBe(false);
    expect(st.blockedAt).toBeUndefined();
  });
});

// ── 4. JSONL fallback (session restore) ─────────────────────────────────────

describe("runPiChatActivation — JSONL fallback", () => {
  it("replays the last JSONL user message when the event lacks a user role", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("restore-fn")]]]),
    });
    deps.__fixture.messages.mockReturnValueOnce([
      { info: { role: "assistant", id: "m-assist" }, parts: [{ type: "text", text: "done" }] },
      { info: { role: "user", id: "m-user" }, parts: [{ type: "text", text: "|restore-fn| resume me" }] },
    ]);

    const result = await runPiChatActivation(
      {
        type: "message_start",
        sessionID: SID,
        messageID: "m-assist-2",
        message: { role: "assistant" },
      },
      { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(true);
    expect(deps.__fixture.messages).toHaveBeenCalledWith(SID);
    // Activation state restored from the last user message.
    expect(functionSessionState.getActive(SID).has("restore-fn")).toBe(true);
  });

  it("does not re-process the same user message on repeated fallback reads (dedup)", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("restore-fn")]]]),
    });
    const sessionMessages = [
      { info: { role: "user", id: "m-user" }, parts: [{ type: "text", text: "|restore-fn| resume me" }] },
    ];
    deps.__fixture.messages.mockReturnValue(sessionMessages);

    const opts = { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } };
    const first = await runPiChatActivation(
      { type: "message_start", sessionID: SID, messageID: "m1", message: { role: "assistant" } },
      opts,
    );
    const second = await runPiChatActivation(
      { type: "message_start", sessionID: SID, messageID: "m2", message: { role: "assistant" } },
      opts,
    );

    expect(first.processed).toBe(true);
    expect(second.processed).toBe(false);
    expect(pipelineRuns(deps)).toBe(1);
  });

  it("skips synthetic injections in the fallback (chat-message.ts:26-29 predicate)", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("guard-fn")]]]),
    });
    deps.__fixture.messages.mockReturnValueOnce([
      { info: { role: "user", id: "m-loop" }, parts: [{ type: "text", text: "[loop-progress round 2/5] worker done" }] },
    ]);

    const result = await runPiChatActivation(
      { type: "message_start", sessionID: SID, messageID: "m1", message: { role: "assistant" } },
      { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(false);
    expect(pipelineRuns(deps)).toBe(0);
    expect(functionSessionState.getActive(SID).size).toBe(0);
  });

  it("skips auto-continue, copilot, and dispatch-notification markers in the fallback too", async () => {
    for (const text of [
      "[auto-continue] check status (1/3)",
      `${COPILOT_MARKER} pi] check status (1/3)`,
      "[GRAPH COMPLETE] node done",
    ]) {
      resetPiChatActivationDedup();
      functionSessionState.clear(SID);
      const deps = makeDeps(tmpDir);
      deps.__fixture.messages.mockReturnValueOnce([
        { info: { role: "user", id: `m-${text.length}` }, parts: [{ type: "text", text }] },
      ]);

      const result = await runPiChatActivation(
        { type: "message_start", sessionID: SID, messageID: "m1", message: { role: "assistant" } },
        { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } },
      );

      expect(result.processed).toBe(false);
      expect(pipelineRuns(deps)).toBe(0);
    }
  });

  it("handles a session read failure gracefully", async () => {
    const deps = makeDeps(tmpDir);
    deps.__fixture.messages.mockReturnValueOnce(
      Promise.reject(new Error("boom")),
    );

    const result = await runPiChatActivation(
      { type: "message_start", sessionID: SID, messageID: "m1", message: { role: "assistant" } },
      { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(false);
  });

  it("returns processed:false when the session has no replayable user message", async () => {
    const deps = makeDeps(tmpDir);
    deps.__fixture.messages.mockReturnValueOnce([
      { info: { role: "assistant", id: "m-a" }, parts: [{ type: "text", text: "hi" }] },
    ]);

    const result = await runPiChatActivation(
      { type: "message_start", sessionID: SID, messageID: "m1", message: { role: "assistant" } },
      { state: new HookState(), deps, activeAgent: { get: () => "agent-a" } },
    );

    expect(result.processed).toBe(false);
    expect(pipelineRuns(deps)).toBe(0);
  });
});

// ── Live-event guards ────────────────────────────────────────────────────────

describe("runPiChatActivation — live-event guards", () => {
  it("returns processed:false when no session id resolves", async () => {
    const deps = makeDeps(tmpDir);
    const result = await runPiChatActivation(
      { type: "message_start", message: { role: "user", content: "hi" } },
      { state: new HookState(), deps },
    );
    expect(result.processed).toBe(false);
    expect(pipelineRuns(deps)).toBe(0);
  });

  it("resolves the session id from the extension ctx sessionManager", async () => {
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("ctx-fn")]]]),
    });
    const result = await runPiChatActivation(
      { type: "message_start", message: { role: "user", content: "|ctx-fn| hi" } },
      {
        ctx: { sessionManager: { getSessionId: () => SID } },
        state: new HookState(),
        deps,
        activeAgent: { get: () => "agent-a" },
      },
    );
    expect(result.processed).toBe(true);
    expect(functionSessionState.getActive(SID).has("ctx-fn")).toBe(true);
  });

  it("registers the session→agent mapping in sessionAgentRegistry", async () => {
    const deps = makeDeps(tmpDir);
    const state = new HookState();
    await runPiChatActivation(
      { type: "message_start", sessionID: SID, messageID: "m1", message: { role: "user", content: "hello" } },
      { state, deps, activeAgent: { get: () => "agent-a" } },
    );
    expect(state.sessionAgentRegistry.get(SID)).toBe("agent-a");
  });
});

// ── wirePiChatActivation ─────────────────────────────────────────────────────

describe("wirePiChatActivation — Pi wiring", () => {
  it("subscribes pi.on('message_start') and drives the pipeline for role-user events", async () => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
    const pi = {
      on: mock((name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers[name] = handler;
      }),
    };
    const deps = makeDeps(tmpDir, {
      roleFunctionsMap: new Map([["agent-a", [makeFn("wire-fn")]]]),
    });

    const wiring = wirePiChatActivation({
      pi,
      state: new HookState(),
      deps,
      activeAgent: { get: () => "agent-a" },
    });

    expect(pi.on).toHaveBeenCalledWith("message_start", expect.any(Function));
    expect(typeof handlers["message_start"]).toBe("function");

    await handlers["message_start"](
      {
        type: "message_start",
        sessionID: SID,
        messageID: "m-wire",
        message: { role: "user", content: "|wire-fn| go" },
      },
      {},
    );

    expect(functionSessionState.getActive(SID).has("wire-fn")).toBe(true);
    wiring.unsubscribe(); // no-op — must not throw
  });

  it("does not fire the pipeline for assistant message events", async () => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
    const pi = {
      on: mock((name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers[name] = handler;
      }),
    };
    const deps = makeDeps(tmpDir);
    deps.__fixture.messages.mockReturnValue([]);

    wirePiChatActivation({
      pi,
      state: new HookState(),
      deps,
      activeAgent: { get: () => "agent-a" },
    });

    await handlers["message_start"](
      { type: "message_start", sessionID: SID, messageID: "m-a", message: { role: "assistant" } },
      {},
    );

    expect(pipelineRuns(deps)).toBe(0);
    expect(functionSessionState.getActive(SID).size).toBe(0);
  });

  it("swallows handler errors instead of throwing into the Pi runtime", async () => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
    const pi = {
      on: mock((name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers[name] = handler;
      }),
    };
    // session.messages rejects AND the event lacks a user role → fallback
    // error path is logged, never thrown.
    const deps = makeDeps(tmpDir);
    deps.__fixture.messages.mockReturnValue(Promise.reject(new Error("disk error")));

    wirePiChatActivation({ pi, state: new HookState(), deps });

    await expect(
      handlers["message_start"](
        { type: "message_start", sessionID: SID, messageID: "m-x", message: { role: "assistant" } },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("degrades gracefully when pi.on is missing", () => {
    const deps = makeDeps(tmpDir);
    const wiring = wirePiChatActivation({
      pi: {},
      state: new HookState(),
      deps,
    });
    wiring.unsubscribe();
    expect(pipelineRuns(deps)).toBe(0);
  });
});
