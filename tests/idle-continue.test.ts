import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap } from "../src/core/composition";
import { buildNotificationText, isDispatchNotification } from "../src/dispatch/notification";
import { roleFunctionsMap } from "../src/index";
import { functionSessionState } from "../src/function/session-state";
import { functionRuntime } from "../src/function/runtime-state";
import type { ResolvedRole, ResolvedFunction } from "../src/types";
import { RoleMode } from "../src/constants";
import { OpencodeSessionAdapter } from "../src/platform/adapters/opencode/session";
import { GraphToolSet } from "../src/graph/tools/graph-tools.ts";
import { sessionSignalLedger } from "../src/signal/session-signal-ledger.ts";
import { createSignalTool } from "../src/signal/signal-tool.ts";
import { runToolObserve } from "../src/function/observe.ts";
import { ArtifactStore } from "../src/function/artifact-store.ts";
import { normalizeWorkspaceDir } from "../src/utils/state-paths.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";

function createMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
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
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

function makePrimaryRole(): ResolvedRole {
  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
    } as any,
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

function makeResolvedFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "plan",
    description: "Plan function",
    content: "Plan mode instructions",
    filePath: "/fake/plan.md",
    source: { type: "builtin" } as any,
    ...overrides,
  };
}

/** Minimal canonical tool context for driving the signal tool directly. */
function makeSignalContext(sessionID: string, directory: string): CanonicalToolContext {
  return {
    sessionID,
    messageID: "msg-gc",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ic-"));
  managerMap.clear();
  roleFunctionsMap.clear();
  functionSessionState.clear("test-session");
  functionRuntime.clearSession("test-session");
  // Module singletons shared across tests in this file — isolate per test so
  // no test reads fn-state / session-signal state written by a sibling.
  functionRuntime.resetAll();
  sessionSignalLedger.resetAll();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  mock.restore();
});

describe("session.idle CONTINUE", () => {
  it("fires promptAsync once when active fn has unmet continue_until", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task\n- [ ] another task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    const callArgs = (promptAsyncMock as any).mock.calls[0][0];
    expect(callArgs.path.id).toBe(sessionID);
    expect(callArgs.body.parts[0].text).toContain("auto-continue");
  });

  it("does NOT fire promptAsync when continue_until is already met (all todos checked)", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [x] done\n- [x] also done";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
    expect(st.phase).toBe("complete");
  });

  it("does NOT fire promptAsync when continuationCount >= continue_max (per-fn cap)", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({
      name: "plan",
      continue_until: "plan_todos_complete",
      continue_max: 5,
    });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending";
    st.continuationCount = 5;

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("skips when no active functions", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("skips fn without continue_until", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan" }); // no continue_until
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    functionRuntime.init(sessionID, "plan", 1);

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("skips fn when st is undefined (not initialized)", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    // Do NOT init functionRuntime — st will be undefined

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("suppresses auto-continue while the parent has in-flight dispatch tasks", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const mgr = managerMap.get(tmpDir)!;
    const inflightSpy = mock(() => 1);
    (mgr as unknown as { getInflightCount: () => number }).getInflightCount = inflightSpy;

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(inflightSpy).toHaveBeenCalled();
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("resumes auto-continue once in-flight dispatches drain to zero", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const mgr = managerMap.get(tmpDir)!;
    (mgr as unknown as { getInflightCount: () => number }).getInflightCount = mock(() => 0);

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    expect((promptAsyncMock as any).mock.calls[0][0].body.parts[0].text).toContain("auto-continue");
  });

  it("suppresses auto-continue while the session owns an executing graph (graphTools stub true)", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    // Stub installed BEFORE createPluginHooks so the GraphToolSet created
    // during ToolService.init resolves the mocked method via the prototype.
    const graphSpy = spyOn(GraphToolSet.prototype, "hasInflightGraphsForSession");
    graphSpy.mockReturnValue(true);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";
    const ccBefore = st.continuationCount;

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(graphSpy).toHaveBeenCalledWith(sessionID);
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
    expect(st.continuationCount).toBe(ccBefore);
  });

  it("continues exactly once when the session owns no executing graph (graphTools stub false)", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const graphSpy = spyOn(GraphToolSet.prototype, "hasInflightGraphsForSession");
    graphSpy.mockReturnValue(false);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(graphSpy).toHaveBeenCalledWith(sessionID);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    expect((promptAsyncMock as any).mock.calls[0][0].body.parts[0].text).toContain("auto-continue");
  });

  it("freezes auto-continue when function state is gated (signal blocked)", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "plan_todos_complete" });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";
    // Simulate signal(type="blocked") — sets phase=gated and evidenceObserved.paused=true
    st.phase = "gated";
    st.evidenceObserved["paused"] = true;
    const ccBefore = st.continuationCount;

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
    expect(st.continuationCount).toBe(ccBefore);
  });

  it("rolls back cooldownUntilTurn alongside continuationCount when the continuation prompt fails", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({
      name: "plan",
      continue_until: "plan_todos_complete",
      continue_max: 5,
    });
    roleFunctionsMap.set("test-primary", [fn]);

    // Stub the session adapter's prompt to reject, simulating a transient
    // failure to send the continuation reminder.
    const adapter = new OpencodeSessionAdapter(client);
    const promptStub = mock(() => Promise.reject(new Error("network down")));
    (adapter as unknown as { prompt: (...args: unknown[]) => Promise<unknown> }).prompt = promptStub;

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: adapter,
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";
    // Set continuationCount one below the first cooldown threshold (atCount: 3),
    // so decideContinuation arms cooldownUntilTurn before the prompt fails.
    st.continuationCount = 2;
    st.cooldownUntilTurn = 0;
    const ccBefore = st.continuationCount;
    const cdBefore = st.cooldownUntilTurn;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    expect(promptStub).toHaveBeenCalledTimes(1);
    // A transient prompt failure must leave BOTH counters exactly as before the
    // call — no stale cooldown, no phantom continuation.
    expect(st.continuationCount).toBe(ccBefore);
    expect(st.cooldownUntilTurn).toBe(cdBefore);
  });
});

describe("auto-continue counter persistence (regression)", () => {
  type ChatMessageHook = (
    input: { agent?: string; sessionID: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;

  it("does not reset continuationCount when the auto-continue prompt re-enters via chat.message", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({
      name: "synthesize",
      continue_until: "plan_todos_complete",
      continue_max: 3,
    });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["synthesize"]);
    const st = functionRuntime.init(sessionID, "synthesize", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    const chatMessage = (hooks as unknown as Record<"chat.message", ChatMessageHook>)["chat.message"];

    const idle = () =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } as any });
    const reminderReenters = (text: string) =>
      chatMessage({ agent: "test-primary", sessionID }, { parts: [{ type: "text", text }] });

    await idle();
    expect(st.continuationCount).toBe(1);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    const reminder1 = (promptAsyncMock as any).mock.calls[0][0].body.parts[0].text as string;
    expect(reminder1).toContain("1/3");

    await reminderReenters(reminder1);
    expect(st.continuationCount).toBe(1);

    await idle();
    expect(st.continuationCount).toBe(2);
    expect((promptAsyncMock as any).mock.calls[1][0].body.parts[0].text).toContain("2/3");

    await reminderReenters((promptAsyncMock as any).mock.calls[1][0].body.parts[0].text);
    expect(st.continuationCount).toBe(2);

    await idle();
    expect(st.continuationCount).toBe(3);
    expect((promptAsyncMock as any).mock.calls[2][0].body.parts[0].text).toContain("3/3");

    await reminderReenters((promptAsyncMock as any).mock.calls[2][0].body.parts[0].text);
    expect(st.continuationCount).toBe(3);

    await idle();
    expect(promptAsyncMock).toHaveBeenCalledTimes(3);
  });

  it("resets continuationCount and cooldown when a genuine user message arrives", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({
      name: "synthesize",
      continue_until: "plan_todos_complete",
      continue_max: 3,
    });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["synthesize"]);
    const st = functionRuntime.init(sessionID, "synthesize", 1);
    st.continuationCount = 2;
    st.cooldownUntilTurn = 5;

    const chatMessage = (hooks as unknown as Record<"chat.message", ChatMessageHook>)["chat.message"];
    await chatMessage(
      { agent: "test-primary", sessionID },
      { parts: [{ type: "text", text: "please keep working on the task" }] },
    );

    expect(st.continuationCount).toBe(0);
    expect(st.cooldownUntilTurn).toBe(0);
  });
});

describe("dispatch-notification counter persistence (regression)", () => {
  type ChatMessageHook = (
    input: { agent?: string; sessionID: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;

  it("classifies dispatch completion reminders as synthetic, not user turns", () => {
    const intermediate = buildNotificationText({
      taskId: "t1", description: "explore", duration: "1s", status: "completed", remainingTasks: 1,
    });
    const final = buildNotificationText({
      taskId: "t1", description: "explore", duration: "1s", status: "completed", remainingTasks: 0,
    });
    expect(isDispatchNotification(intermediate)).toBe(true);
    expect(isDispatchNotification(final)).toBe(true);
    expect(isDispatchNotification("please keep working")).toBe(false);
  });

  it("does not reset continuationCount when a dispatch completion reminder re-enters via chat.message", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({
      name: "synthesize",
      continue_until: "plan_todos_complete",
      continue_max: 3,
    });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "test-session";
    functionSessionState.activate(sessionID, ["synthesize"]);
    const st = functionRuntime.init(sessionID, "synthesize", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    const chatMessage = (hooks as unknown as Record<"chat.message", ChatMessageHook>)["chat.message"];

    const idle = () =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } as any });
    const completionReenters = () =>
      chatMessage(
        { agent: "test-primary", sessionID },
        { parts: [{ type: "text", text: buildNotificationText({
          taskId: "bg1", description: "explore", duration: "2s", status: "completed", remainingTasks: 0,
        }) }] },
      );

    await idle();
    expect(st.continuationCount).toBe(1);

    await completionReenters();
    expect(st.continuationCount).toBe(1);

    await idle();
    expect(st.continuationCount).toBe(2);

    await completionReenters();
    await idle();
    expect(st.continuationCount).toBe(3);

    await completionReenters();
    await idle();
    expect(promptAsyncMock).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end regression for the user-reported scenario (subtask 6): a function
// whose `continue_until` is the structured disjunction
//   { any: [signal_observed(answer), artifact_exists(final_answer)] }
// must continue exactly once, then complete when the model emits
// signal(type="answer") — and a signal recorded ONLY at the session level
// (no active fn at emission time) must still complete the fn once idle runs,
// including while graph-execution suppression (subtask 3) is in force.
// ─────────────────────────────────────────────────────────────────────────────

describe("graph-continuation: structured { any: [...] } continue_until (subtask 6)", () => {
  const ANY_CONDITION = { any: ["signal_observed(answer)", "artifact_exists(final_answer)"] };

  it("(a) signal(answer) via the signal tool completes after exactly one continuation", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "synthesize", continue_until: ANY_CONDITION });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "gc-a-signal-tool";
    functionSessionState.activate(sessionID, ["synthesize"]);
    const st = functionRuntime.init(sessionID, "synthesize", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    const idle = () =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    // 1st idle: neither arm of the any-condition is met → exactly ONE continuation.
    await idle();
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    expect(st.continuationCount).toBe(1);
    expect(st.phase).toBe("active");
    expect((promptAsyncMock as any).mock.calls[0][0].body.parts[0].text).toContain("auto-continue");

    // The model calls signal(type="answer") — real tool path. Records at both
    // the session level and on the active fn's FnState ledger.
    const signalTool = createSignalTool();
    await signalTool.execute({ type: "answer" }, makeSignalContext(sessionID, tmpDir));

    // 2nd idle: signal_observed(answer) is now satisfied → phase completes.
    // No second continuation: continuationCount stays 1 and promptAsync was
    // called exactly once in total.
    await idle();
    expect(st.phase).toBe("complete");
    expect(st.continuationCount).toBe(1);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("(a) signal(answer) observed via the tool.execute.after path (runToolObserve) also completes", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "synthesize", continue_until: ANY_CONDITION });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "gc-a-observe";
    functionSessionState.activate(sessionID, ["synthesize"]);
    const st = functionRuntime.init(sessionID, "synthesize", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    const idle = () =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    await idle();
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    expect(st.continuationCount).toBe(1);

    // Simulate the tool.execute.after hook feeding observe with the signal
    // call — the same runToolObserve shape handleToolAfter passes
    // (tool:"signal", toolArgs:{type:"answer"}).
    runToolObserve({
      sessionID,
      tool: "signal",
      activeFns: [fn],
      artifacts: new ArtifactStore(tmpDir),
      lastAssistantText: null,
      toolArgs: { type: "answer" },
    });

    await idle();
    expect(st.phase).toBe("complete");
    expect(st.continuationCount).toBe(1);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("(a) the artifact_exists(final_answer) arm of the any-condition completes without a signal", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "synthesize", continue_until: ANY_CONDITION });
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    const sessionID = "gc-a-artifact";
    functionSessionState.activate(sessionID, ["synthesize"]);
    const st = functionRuntime.init(sessionID, "synthesize", 1);
    st.kv["__todos"] = "- [ ] pending task";

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    const idle = () =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    await idle();
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    expect(st.continuationCount).toBe(1);

    // The final_answer artifact lands (e.g. extracted via observe capture).
    // Write through the normalized dir the handlers resolve so
    // artifact_exists(final_answer) reads the same physical file.
    new ArtifactStore(normalizeWorkspaceDir(tmpDir)).write(sessionID, "final_answer", "done");

    await idle();
    expect(st.phase).toBe("complete");
    expect(st.continuationCount).toBe(1);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("graph-continuation: graph suppression + session-ledger fallback (subtasks 3+4)", () => {
  it("(b) a session-only signal completes the fn once idle runs after the graph settles", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan", continue_until: "signal_observed(answer)" });
    roleFunctionsMap.set("test-primary", [fn]);

    const sessionID = "gc-b-ledger";
    // Bare signal emitted with NO active function: the signal tool records
    // only at the session level in that branch (signal-tool.ts) — the FnState
    // ledger is never written.
    const signalTool = createSignalTool();
    await signalTool.execute({ type: "answer" }, makeSignalContext(sessionID, tmpDir));
    expect(sessionSignalLedger.hasSignal(sessionID, "answer")).toBe(true);

    // Stub BEFORE createPluginHooks so the GraphToolSet assembled during
    // ToolService.init resolves the mocked method via the prototype.
    const graphSpy = spyOn(GraphToolSet.prototype, "hasInflightGraphsForSession");

    const hooks = await createPluginHooks({
      resolvedRoles: [makePrimaryRole()],
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap: new Map(),
      directory: tmpDir,
    });

    functionSessionState.activate(sessionID, ["plan"]);
    const st = functionRuntime.init(sessionID, "plan", 1);
    st.kv["__todos"] = "- [ ] pending task";
    // The signal was never recorded on the fn state — only the session ledger.
    expect(st.kv["__signals_observed"]).toBeUndefined();

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;
    const idle = () =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

    // (1) Session owns an executing graph → idle is suppressed entirely
    //     (subtask 3: hasInflightGraphsForSession) — no continuation, no
    //     completion evaluation.
    graphSpy.mockReturnValue(true);
    await idle();
    expect(graphSpy).toHaveBeenCalledWith(sessionID);
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
    expect(st.phase).toBe("active");
    expect(st.continuationCount).toBe(0);

    // (2) Graph settles → idle re-evaluates. signal_observed(answer) has no
    //     FnState entry but falls back to the session ledger (subtask 4) →
    //     the fn completes with zero continuation prompts.
    graphSpy.mockReturnValue(false);
    await idle();
    expect(st.phase).toBe("complete");
    expect(st.continuationCount).toBe(0);
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });
});
