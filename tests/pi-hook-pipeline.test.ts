/**
 * Pi hook pipeline tests (subtask S6).
 *
 * Verifies `src/platform/adapters/pi/hook-pipeline.ts`:
 *   1. **session.idle** through the bridge triggers
 *      dispatchManager.handleSessionIdle and then, for an active function
 *      whose continue_until is unmet, a continuation prompt — a
 *      `session.prompt` call whose text contains the auto-continue
 *      `<system-reminder>`.
 *   2. A **custom hook** declared in a role's `config.hooks.custom` is
 *      registered into the pipeline's CustomHookRegistry and fires on the
 *      matching event.
 *   3. **functionRuntime state persistence**: state written under the
 *      pipeline dir is recovered by a fresh pipeline pointed at the same
 *      dir (setStoreDirectory + recover, hook-service.ts:59-66 pattern).
 *   4. The pipeline is the single dispatch path: session.status /
 *      session.error / message.updated canonical events route through
 *      handleEvent into the dispatchManager (no ad-hoc handlers remain).
 *   5. The assembled HookDeps shape: session = the provided client,
 *      dir, role maps, loopManager, notificationManager passthrough,
 *      builtInHooks/recoveryEngine omitted.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPiHookPipeline } from "../src/platform/adapters/pi/hook-pipeline.ts";
import { PiEventBridge } from "../src/platform/adapters/pi/event-bridge.ts";
import { functionRuntime } from "../src/function/runtime-state.ts";
import { functionSessionState } from "../src/function/session-state.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import type { LoopCoordinator } from "../src/loop/coordinator.ts";
import type { ResolvedRole, ResolvedFunction } from "../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

interface PromptRecord {
  id: string;
  text: string;
  agent?: string;
}

/** Recordable ISessionClient — prompt() captures calls, others are inert. */
function makeSessionClient(): ISessionClient & { prompts: PromptRecord[] } {
  const prompts: PromptRecord[] = [];
  const client = {
    prompts,
    async prompt(
      id: string,
      options: {
        parts: Array<{ type: string; text: string }>;
        agent?: string;
      },
    ): Promise<{ id: string } | null> {
      prompts.push({
        id,
        text: options.parts.map((p) => p.text).join("\n"),
        agent: options.agent,
      });
      return { id };
    },
    async messages(): Promise<never[]> {
      return [];
    },
    async list(): Promise<never[]> {
      return [];
    },
    async get(): Promise<null> {
      return null;
    },
    async children(): Promise<never[]> {
      return [];
    },
    async todo(): Promise<never[]> {
      return [];
    },
    async diff(): Promise<never[]> {
      return [];
    },
    async fork(): Promise<null> {
      return null;
    },
    async status(): Promise<{ type: string } | null> {
      return { type: "idle" };
    },
    async promptSync(): Promise<{ parts: [] } | null> {
      return { parts: [] };
    },
    async create(): Promise<null> {
      return null;
    },
    async abort(): Promise<boolean> {
      return true;
    },
  } as ISessionClient & { prompts: PromptRecord[] };
  return client;
}

/** DispatchManager spy covering the handleEvent lifecycle surface. */
function makeDispatchManager(): {
  calls: {
    idle: string[];
    status: Array<[string, string]>;
    error: Array<[string, unknown]>;
    deleted: string[];
    messageUpdated: string[];
  };
  manager: DispatchManager;
} {
  const calls = {
    idle: [] as string[],
    status: [] as Array<[string, string]>,
    error: [] as Array<[string, unknown]>,
    deleted: [] as string[],
    messageUpdated: [] as string[],
  };
  const manager = {
    handleSessionIdle: async (sid: string) => {
      calls.idle.push(sid);
    },
    handleSessionStatus: async (sid: string, statusType: string) => {
      calls.status.push([sid, statusType]);
    },
    handleSessionError: async (sid: string, err: unknown) => {
      calls.error.push([sid, err]);
    },
    handleSessionDeleted: async (sid: string) => {
      calls.deleted.push(sid);
    },
    handleMessageUpdated: (sid: string) => {
      calls.messageUpdated.push(sid);
    },
    isSyncSession: () => false,
    getInflightCount: () => 0,
    getTasksByParent: () => [],
  } as unknown as DispatchManager;
  return { calls, manager };
}

/** Minimal LoopCoordinator stub — never a loop origin, no loop state. */
function makeLoopManager(): LoopCoordinator {
  return {
    isActiveLoopOrigin: () => false,
    isLoopSession: () => false,
    getLoopState: () => undefined,
  } as unknown as LoopCoordinator;
}

function makeRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A test role for the Pi hook pipeline",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  };
}

function makeFunction(
  name: string,
  overrides?: Partial<ResolvedFunction>,
): ResolvedFunction {
  return {
    name,
    description: "test function",
    content: "test content",
    filePath: `/tmp/${name}.ts`,
    source: "role-local",
    ...overrides,
  };
}

interface BuildOptions {
  bridge: PiEventBridge;
  client: ISessionClient;
  roles: ResolvedRole[];
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  dispatch: DispatchManager;
  dir: string;
  notificationManager?: unknown;
}

/** Assemble a pipeline with the standard fixture set. */
function buildPipeline(opts: BuildOptions) {
  return createPiHookPipeline({
    eventBridge: opts.bridge,
    session: opts.client,
    resolvedRoles: opts.roles,
    roleFunctionsMap: opts.roleFunctionsMap,
    roleGraphMap: new Map(),
    dispatchManager: opts.dispatch,
    loopManager: makeLoopManager(),
    notificationManager: opts.notificationManager as never,
    dir: opts.dir,
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-hook-pipeline-"));
});

afterEach(() => {
  functionRuntime.resetAll();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── (a) session.idle → handleSessionIdle + continuation prompt ──────────────

describe("Pi hook pipeline — session.idle", () => {
  it("triggers dispatchManager.handleSessionIdle then a continuation prompt with a reminder for an active function with unmet continue_until", async () => {
    const sid = "sess-cont";
    const fnName = "cont-fn";
    const testFn = makeFunction(fnName, { continue_until: "never_satisfied" });
    const roleFunctionsMap = new Map([["test-role", [testFn]]]);

    const bridge = new PiEventBridge();
    const client = makeSessionClient();
    const { manager, calls } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client,
      roles: [makeRole()],
      roleFunctionsMap,
      dispatch: manager,
      dir: tmpDir,
    });

    // Pre-arm function state the way the chat-message/auto-activate path does.
    functionRuntime.resetAll();
    functionSessionState.clear(sid);
    functionSessionState.activate(sid, [fnName]);
    functionRuntime.init(sid, fnName, 1); // phase "active"

    try {
      await bridge.emit({
        type: "session.idle",
        rawType: "agent_end",
        properties: { sessionID: sid },
      });

      // (1) Dispatch manager sees the idle.
      expect(calls.idle).toEqual([sid]);

      // (2) Exactly ONE continuation prompt with the auto-continue reminder.
      expect(client.prompts).toHaveLength(1);
      expect(client.prompts[0].id).toBe(sid);
      expect(client.prompts[0].text).toContain("<system-reminder>");
      expect(client.prompts[0].text).toContain("[auto-continue");
      expect(functionRuntime.get(sid, fnName)!.continuationCount).toBe(1);
    } finally {
      await pipeline.dispose();
      functionRuntime.resetAll();
      functionSessionState.clear(sid);
    }
  });

  it("does not continue when the active function's continue_until is already met", async () => {
    const sid = "sess-done";
    const fnName = "done-fn";
    // tool_observed("done") is satisfied because toolsObserved contains it.
    const testFn = makeFunction(fnName, { continue_until: "tool_observed(done)" });
    const roleFunctionsMap = new Map([["test-role", [testFn]]]);

    const bridge = new PiEventBridge();
    const client = makeSessionClient();
    const { manager, calls } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client,
      roles: [makeRole()],
      roleFunctionsMap,
      dispatch: manager,
      dir: tmpDir,
    });

    functionRuntime.resetAll();
    functionSessionState.clear(sid);
    functionSessionState.activate(sid, [fnName]);
    const st = functionRuntime.init(sid, fnName, 1);
    st.toolsObserved = ["done"];

    try {
      await bridge.emit({
        type: "session.idle",
        rawType: "agent_end",
        properties: { sessionID: sid },
      });

      expect(calls.idle).toEqual([sid]);
      expect(client.prompts).toHaveLength(0);
      // Satisfied continue_until completes the function.
      expect(functionRuntime.get(sid, fnName)!.phase).toBe("complete");
    } finally {
      await pipeline.dispose();
      functionRuntime.resetAll();
      functionSessionState.clear(sid);
    }
  });
});

// ── (b) custom hooks from role config hooks.custom ──────────────────────────

describe("Pi hook pipeline — custom hooks", () => {
  it("fires a custom hook declared in a role's config.hooks.custom", async () => {
    writeFileSync(
      join(tmpDir, "record-hook.ts"),
      [
        `export const onEvent = (ctx: any, input: any): void => {`,
        `  const g = globalThis as any;`,
        `  g.__piHookFired ??= [];`,
        `  g.__piHookFired.push({ type: input.type, sessionID: ctx.sessionID });`,
        `};`,
      ].join("\n"),
    );

    const role = makeRole({
      config: {
        name: "Test Role",
        description: "A test role for the Pi hook pipeline",
        prompt: "You are a test role.",
        hooks: {
          custom: [
            {
              name: "record-hook",
              events: ["event"],
              module: "./record-hook.ts",
            },
          ],
        },
      },
    });

    const bridge = new PiEventBridge();
    const client = makeSessionClient();
    const { manager } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client,
      roles: [role],
      roleFunctionsMap: new Map(),
      dispatch: manager,
      dir: tmpDir,
    });

    try {
      (globalThis as Record<string, unknown>).__piHookFired = [];
      await bridge.emit({
        type: "session.idle",
        rawType: "agent_end",
        properties: { sessionID: "sess-hook" },
      });

      const fired = (globalThis as Record<string, unknown>).__piHookFired as
        | Array<{ type: string; sessionID?: string }>
        | undefined;
      expect(fired).toBeDefined();
      expect(fired!).toHaveLength(1);
      expect(fired![0]).toEqual({
        type: "session.idle",
        sessionID: "sess-hook",
      });
    } finally {
      delete (globalThis as Record<string, unknown>).__piHookFired;
      await pipeline.dispose();
    }
  });

  it("registers no hooks when a role has no hooks.custom config", async () => {
    const bridge = new PiEventBridge();
    const client = makeSessionClient();
    const { manager } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client,
      roles: [makeRole()],
      roleFunctionsMap: new Map(),
      dispatch: manager,
      dir: tmpDir,
    });

    try {
      expect(pipeline.deps.customHooks.getHooks("event", "after")).toHaveLength(0);
    } finally {
      await pipeline.dispose();
    }
  });
});

// ── (c) functionRuntime persistence + recovery ──────────────────────────────

describe("Pi hook pipeline — persistent state recovery", () => {
  it("persists functionRuntime state under the pipeline dir and recovers it on a fresh pipeline", async () => {
    const sid = "sess-persist";
    const fnName = "persist-fn";
    const roleFunctionsMap = new Map([["test-role", [makeFunction(fnName)]]]);

    const bridge1 = new PiEventBridge();
    const pipeline1 = await buildPipeline({
      bridge: bridge1,
      client: makeSessionClient(),
      roles: [makeRole()],
      roleFunctionsMap,
      dispatch: makeDispatchManager().manager,
      dir: tmpDir,
    });

    try {
      functionRuntime.resetAll();
      const st = functionRuntime.init(sid, fnName, 1);
      st.phase = "active";
      st.continuationCount = 2;
      functionRuntime.markDirty();
      functionRuntime.flushSync();

      // State file landed under the dir.
      const stateDir = join(tmpDir, ".rolebox", "state");
      expect(existsSync(stateDir)).toBe(true);
      const files = readdirSync(stateDir).filter((f) => f.startsWith("fnstate-"));
      expect(files.length).toBeGreaterThan(0);

      // A second pipeline against the same dir recovers the persisted state.
      const bridge2 = new PiEventBridge();
      const pipeline2 = await buildPipeline({
        bridge: bridge2,
        client: makeSessionClient(),
        roles: [makeRole()],
        roleFunctionsMap,
        dispatch: makeDispatchManager().manager,
        dir: tmpDir,
      });

      try {
        const restored = functionRuntime.get(sid, fnName);
        expect(restored).toBeDefined();
        expect(restored!.phase).toBe("active");
        expect(restored!.continuationCount).toBe(2);
      } finally {
        await pipeline2.dispose();
      }
    } finally {
      await pipeline1.dispose();
      functionRuntime.resetAll();
      functionSessionState.clear(sid);
    }
  });
});

// ── single dispatch path (replaces the five ad-hoc bridge handlers) ─────────

describe("Pi hook pipeline — single handleEvent dispatch", () => {
  it("routes session.status through handleEvent to dispatchManager.handleSessionStatus", async () => {
    const bridge = new PiEventBridge();
    const { manager, calls } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client: makeSessionClient(),
      roles: [makeRole()],
      roleFunctionsMap: new Map(),
      dispatch: manager,
      dir: tmpDir,
    });

    try {
      await bridge.emit({
        type: "session.status",
        rawType: "agent_settled",
        properties: { sessionID: "sess-status", status: "idle" },
      });
      expect(calls.status).toEqual([["sess-status", "idle"]]);
    } finally {
      await pipeline.dispose();
    }
  });

  it("routes session.error and message.updated into the dispatchManager", async () => {
    const bridge = new PiEventBridge();
    const { manager, calls } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client: makeSessionClient(),
      roles: [makeRole()],
      roleFunctionsMap: new Map(),
      dispatch: manager,
      dir: tmpDir,
    });

    try {
      await bridge.emit({
        type: "session.error",
        rawType: "process.error",
        properties: { sessionID: "sess-err", error: "boom" },
      });
      expect(calls.error).toEqual([["sess-err", "boom"]]);

      await bridge.emit({
        type: "message.updated",
        rawType: "message_update",
        properties: { info: { sessionID: "sess-msg" } },
      });
      expect(calls.messageUpdated).toEqual(["sess-msg"]);
    } finally {
      await pipeline.dispose();
    }
  });

  it("unsubscribe() detaches the bridge — later events never reach handleEvent", async () => {
    const bridge = new PiEventBridge();
    const { manager, calls } = makeDispatchManager();
    const pipeline = await buildPipeline({
      bridge,
      client: makeSessionClient(),
      roles: [makeRole()],
      roleFunctionsMap: new Map(),
      dispatch: manager,
      dir: tmpDir,
    });

    pipeline.unsubscribe();
    await bridge.emit({
      type: "session.error",
      rawType: "process.error",
      properties: { sessionID: "sess-unsub", error: "late" },
    });
    expect(calls.error).toEqual([]);
  });
});

// ── HookDeps shape ──────────────────────────────────────────────────────────

describe("Pi hook pipeline — HookDeps assembly", () => {
  it("assembles the full HookDeps from the provided options (builtInHooks omitted)", async () => {
    const bridge = new PiEventBridge();
    const client = makeSessionClient();
    const { manager } = makeDispatchManager();
    const notificationManager = { mock: true };
    const roleFunctionsMap = new Map<string, ResolvedFunction[]>();
    const pipeline = await buildPipeline({
      bridge,
      client,
      roles: [makeRole()],
      roleFunctionsMap,
      dispatch: manager,
      dir: tmpDir,
      notificationManager,
    });

    try {
      expect(pipeline.deps.session).toBe(client);
      expect(pipeline.deps.dir).toBe(tmpDir);
      expect(pipeline.deps.dispatchManager).toBe(manager);
      expect(pipeline.deps.loopManager).toBeDefined();
      expect(pipeline.deps.roleMap.get("test-role")).toBeDefined();
      expect(pipeline.deps.roleFunctionsMap).toBe(roleFunctionsMap);
      expect(pipeline.deps.roleGraphMap).toBeDefined();
      expect(pipeline.deps.customHooks).toBeDefined();
      expect(pipeline.deps.notificationManager).toBe(notificationManager as never);
      // Recovery/built-in engine is opencode-only — omitted on Pi.
      expect(pipeline.deps.builtInHooks).toBeUndefined();
      expect(pipeline.deps.recoveryEngine).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  });
});
