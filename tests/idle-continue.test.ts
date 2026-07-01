import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap } from "../src/plugin-hooks";
import { buildNotificationText, isDispatchNotification } from "../src/dispatch/notification";
import { roleFunctionsMap } from "../src/index";
import { functionSessionState } from "../src/session-state";
import { functionRuntime } from "../src/function/runtime-state";
import type { ResolvedRole, ResolvedFunction } from "../src/types";
import { RoleMode } from "../src/constants";

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ic-"));
  managerMap.clear();
  roleFunctionsMap.clear();
  functionSessionState.clear("test-session");
  functionRuntime.clearSession("test-session");
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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

    const promptAsyncMock = client.session.promptAsync as ReturnType<typeof mock>;

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });

    expect(promptAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("skips fn without continue_until", async () => {
    const client = createMockClient();
    const fn = makeResolvedFn({ name: "plan" }); // no continue_until
    roleFunctionsMap.set("test-primary", [fn]);

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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

    const hooks = await createPluginHooks(
      [makePrimaryRole()],
      client,
      roleFunctionsMap,
      new Map(),
      tmpDir,
    );

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
