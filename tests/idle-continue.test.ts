import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap } from "../src/plugin-hooks";
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
