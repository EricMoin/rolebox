/**
 * Pi service stack — graph behavior E2E through the compiled Pi tool surface.
 *
 * Exercises the objects the Pi stack actually registers (`PiLightweightServiceStack.init()`
 * → `PiToolFactory.compileAll` → `getHandlers().tool`), driving the compiled tools'
 * `execute(toolCallId, params, signal, onUpdate, ctx)` signature with a fake Pi ctx.
 *
 * Scenarios:
 *   1. **graph-notify seam** — graph_create → graph_add_node → graph_run through the
 *      compiled tools completes a node and routes `[GRAPH NODE COMPLETED]` (per-node,
 *      noReply=true) plus `[GRAPH COMPLETE]` (terminal, noReply=false) reminders to the
 *      fake ISessionClient, targeting the emperor session resolved from the fake ctx's
 *      sessionID (the Pi stack wires `emperorSessionId: (invoking) => invoking`).
 *   2. **approval** — a `needs_approval` node pauses: the pausing `need_approval` signal
 *      is delivered through the engine's public pausing-signal seam (the documented
 *      "worker emits need_approval" entry, cf. engine-terminal.test.ts / approval-handler.test.ts),
 *      a `[GRAPH BLOCKED]` reminder is delivered, and the compiled `graph_approve` tool
 *      with `action=approve` resumes the node to completed (a `[GRAPH COMPLETE]` follows).
 *      NOTE on delivery: the engine's dispatch termination mapping (`mapDispatchStatusToSignal`,
 *      engine-recovery.ts) maps only `completed`/`error`/`timeout` — `need_approval` is a
 *      PAUSING signal (signal-constants.ts) and is not mapped, so the blocked transition is
 *      driven through the engine seam, exactly as the engine-level tests do.
 *   3. **persistence** — with `stateDir=<tmp dir>`, a completed run writes
 *      `engine-*.json` under `<tmp dir>/.rolebox/state` (engineStatePath, engine-persistence.ts),
 *      and the compiled `graph_status` with `scope=persisted` lists the graph (cross-session
 *      scan over the on-disk store).
 *
 * Fixture patterns: FakeSessionClient from tests/graph/graph-notify-wiring.test.ts:39-92;
 * stub DispatchManager launch/onTaskTerminated from tests/graph/engine-startup.test.ts:58-67
 * (plus the completeLatest() fire pattern of graph-notify-wiring.test.ts:103-148).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import { PiToolFactory } from "../src/platform/adapters/pi/tool-factory.ts";
import { createGraphToolSet } from "../src/graph/tools/graph-tools.ts";
import { createGraphApproveTool } from "../src/graph/tools/approve-tools.ts";
import type { ResolvedRole } from "../src/types.ts";
import type { DispatchManager } from "../src/dispatch/core/manager.ts";
import type { DispatchTask } from "../src/dispatch/types.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import {
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
  GRAPH_BLOCKED_MARKER,
  clearParentQueues,
} from "../src/dispatch/notification.ts";

// ── Fake ISessionClient (graph-notify-wiring.test.ts:39-92 pattern) ──────────

class FakeSessionClient implements ISessionClient {
  prompts: Array<{ id: string; text: string; noReply?: boolean; agent?: string }> = [];

  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      agent?: string;
    },
  ): Promise<{ id: string } | null> {
    this.prompts.push({
      id,
      text: options.parts.map((p) => p.text).join("\n"),
      noReply: options.noReply,
      agent: options.agent,
    });
    return { id };
  }

  async list(): Promise<never> {
    throw new Error("not implemented");
  }
  async get(): Promise<never> {
    throw new Error("not implemented");
  }
  async messages(): Promise<never> {
    throw new Error("not implemented");
  }
  async children(): Promise<never> {
    throw new Error("not implemented");
  }
  async todo(): Promise<never> {
    throw new Error("not implemented");
  }
  async diff(): Promise<never> {
    throw new Error("not implemented");
  }
  async fork(): Promise<never> {
    throw new Error("not implemented");
  }
  async status(): Promise<never> {
    throw new Error("not implemented");
  }
  async promptSync(): Promise<never> {
    throw new Error("not implemented");
  }
  async create(): Promise<never> {
    throw new Error("not implemented");
  }
  async abort(): Promise<never> {
    throw new Error("not implemented");
  }
}

// ── Stub DispatchManager (engine-startup.test.ts:58-67 pattern) ───────────────

/**
 * Minimal fake satisfying the `DispatchManager` surface the engine touches:
 * `launch` returns a running task, `onTaskTerminated` registers a per-task
 * listener, `getTask` reads the task map, and `completeLatest()` fires the
 * listener with `"completed"` (the graph-notify-wiring FakeDispatchSeam
 * pattern). Cast to the concrete class type — a full manager is far too heavy
 * for a unit test.
 */
class StubDispatchManager {
  tasks = new Map<string, DispatchTask>();
  private listeners = new Map<string, (taskId: string, status: string) => void>();
  private seq = 0;

  async launch(_input?: { prompt?: unknown }): Promise<DispatchTask> {
    this.seq += 1;
    const task: DispatchTask = {
      id: `task-${this.seq}`,
      sessionId: `sess-${this.seq}`,
      parentSessionId: "graph-e2e",
      depth: 1,
      status: "running",
      agent: "a",
      prompt: "p",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  onTaskTerminated(
    taskId: string,
    cb: (taskId: string, status: string) => void,
  ): (taskId: string, status: string) => void {
    this.listeners.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Mark the latest task completed → fires the onTaskTerminated listener. */
  completeLatest(): void {
    let latestTaskId: string | undefined;
    for (const id of this.tasks.keys()) latestTaskId = id;
    if (!latestTaskId) throw new Error("no dispatched task to complete");
    const task = this.tasks.get(latestTaskId)!;
    task.status = "completed";
    const cb = this.listeners.get(latestTaskId);
    if (cb) cb(latestTaskId, "completed");
  }

  getTasksByParent(): DispatchTask[] {
    return [];
  }
  getEventState(): Map<string, unknown> {
    return new Map();
  }
  getBudgetTracker(): {
    isRequestBudgetExceeded: () => { exceeded: boolean };
    getRequestUsage: () => { inputTokens: number; outputTokens: number; cost: number };
    getSessionUsage: () => { inputTokens: number; outputTokens: number; cost: number };
  } {
    return {
      isRequestBudgetExceeded: () => ({ exceeded: false }),
      getRequestUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0 }),
      getSessionUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0 }),
    };
  }
  async cancelTask(): Promise<boolean> {
    return true;
  }
}

function stubManager(): DispatchManager {
  return new StubDispatchManager() as unknown as DispatchManager;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const emptyRole: ResolvedRole = {
  id: "test-role",
  config: {
    name: "Test Role",
    description: "A test role for Pi graph e2e tests",
    prompt: "You are a test role.",
  },
  prompt: "You are a test role.",
  skills: [],
  functions: [],
  references: [],
  subagents: [],
};

/** The emperor/orchestrator session — the fake ctx sessionID graph_run forwards. */
const EMPEROR_SESSION = "emperor-session-42";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-graph-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  clearParentQueues();
});

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ── Compiled-surface helpers ──────────────────────────────────────────────────

/**
 * Build the stack exactly like the platform entry does: fake client (9th ctor
 * arg = graphNotifyClient, so reminders route to it instead of the filesystem
 * PiSessionAdapter), stub manager (8th arg gates graph_* registration), tmp
 * stateDir (10th arg keeps engine-state writes out of the repo).
 */
function makeStack(
  client: FakeSessionClient,
  manager: StubDispatchManager,
  stateDir: string,
): PiLightweightServiceStack {
  const mockPi = {
    registerTool: () => {},
    on: () => {},
  };
  return new PiLightweightServiceStack(
    mockPi,
    [emptyRole],
    undefined, // sessionDir
    undefined, // dispatchTools
    undefined, // loopTools
    undefined, // taskTools
    undefined, // extraTools
    manager as unknown as DispatchManager,
    client,
    stateDir,
  );
}

/**
 * Drive a Pi-compiled tool through its `execute(toolCallId, params, signal,
 * onUpdate, ctx)` signature (the exact surface Pi invokes) with a fake pi ctx.
 */
async function exec(
  tool: {
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (msg: string) => void,
      ctx: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  },
  params: Record<string, unknown>,
  sessionID: string = EMPEROR_SESSION,
) {
  return tool.execute(
    "call-1",
    params,
    new AbortController().signal,
    () => {},
    {
      sessionID,
      messageID: "m-1",
      directory: "/tmp",
      worktree: "/tmp",
      agent: "emperor",
    },
  );
}

/** Parse the JSON string a JSON-rendering compiled tool returns. */
function parse(out: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(out.content[0].text);
}

/** Flush the microtask chain (engine advance → notifier → notify queue). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function reminder(
  client: FakeSessionClient,
  marker: string,
): { id: string; text: string; noReply?: boolean } | undefined {
  return client.prompts.find((p) => p.text.includes(marker));
}

// ── (a) graph-notify seam through the compiled Pi surface ────────────────────

describe("graph-notify seam through the compiled Pi surface", () => {
  it("graph_run completes a node and delivers [GRAPH NODE COMPLETED] + [GRAPH COMPLETE] to the emperor session", async () => {
    const client = new FakeSessionClient();
    const manager = new StubDispatchManager();
    const stack = makeStack(client, manager, makeTmpDir());
    await stack.init();
    const tools = stack.getHandlers().tool as Record<string, any>;

    // graph_create → graph_add_node → graph_run via the compiled execute().
    const created = parse(await exec(tools.graph_create, { name: "notify-e2e" }));
    await exec(tools.graph_add_node, {
      graph_id: created.graph_id,
      id: "A",
      agent: "emperor--jinyiwei--ui",
      prompt: "do the thing",
    });
    const run = parse(await exec(tools.graph_run, { graph_id: created.graph_id }));
    expect(run.phase).toBe("executing");
    expect(run.active_nodes).toContain("A");

    // The stub dispatch fires the terminal status → the engine advances.
    manager.completeLatest();
    await flush();

    // Per-node reminder (fires first; silent — noReply=true).
    const nodeReminder = reminder(client, GRAPH_COMPLETION_MARKER);
    expect(nodeReminder).toBeDefined();
    expect(nodeReminder!.id).toBe(EMPEROR_SESSION);
    expect(nodeReminder!.noReply).toBe(true);
    expect(nodeReminder!.text).toContain("graph: notify-e2e");
    expect(nodeReminder!.text).toContain("node: A");
    expect(nodeReminder!.text).toContain("status: completed");

    // Graph-terminal reminder (fires second; wakes the orchestrator — noReply=false).
    const terminal = reminder(client, GRAPH_COMPLETE_MARKER);
    expect(terminal).toBeDefined();
    expect(terminal!.id).toBe(EMPEROR_SESSION);
    expect(terminal!.noReply).toBe(false);

    // The compiled graph_status confirms the live node completed.
    const status = await exec(tools.graph_status, { graph_id: created.graph_id });
    expect(status.content[0].text).toContain("complete");
    expect(status.content[0].text).toContain("completed");
  });
});

// ── (b) approval through the compiled surface ────────────────────────────────

describe("needs_approval gate through the compiled surface", () => {
  it("blocks the node, delivers [GRAPH BLOCKED], and the compiled graph_approve resumes it", async () => {
    const client = new FakeSessionClient();
    const manager = new StubDispatchManager();
    const stateDir = makeTmpDir();

    // Construct the exact graph toolset the Pi stack builds internally
    // (createGraphTools passes manager / stateDir / graphNotify down to
    // createGraphToolSet with these same arguments). Holding the toolset lets
    // the test reach the engine's public pausing-signal seam.
    const ts = createGraphToolSet({
      manager: manager as unknown as DispatchManager,
      stateDir,
      graphNotify: {
        sessionClient: client,
        emperorSessionId: (invokingSessionId) => invokingSessionId,
      },
    });

    const { graph_id } = ts.graph_create({ name: "approval-e2e" }, EMPEROR_SESSION);
    ts.graph_add_node({
      graph_id,
      id: "G",
      agent: "emperor--jinyiwei--ui",
      prompt: "Approve the final output.",
      needs_approval: true,
    });
    await ts.graph_run({ graph_id }, EMPEROR_SESSION);
    expect(ts["getEntry"](graph_id).runtime.status().phase).toBe("executing");

    // Deliver the pausing `need_approval` signal through the engine's public
    // seam — the documented "worker emits need_approval" entry (engine-advance
    // `_advance`, engine-terminal.test.ts). The runtime's `advance` field is
    // TS-private; bracket access is the in-repo test idiom
    // (graph-approve.test.ts:36-42 uses the same on the registry).
    const runtime = (ts as unknown as { getEntry(id: string): { runtime: any } })["getEntry"](graph_id).runtime;
    await runtime["advance"].onNodeSignalEmitted("G", "need_approval", "please review");
    await flush();

    // The graph is quiescent-blocked: BLOCKED reminder delivered, node blocked.
    const blocked = reminder(client, GRAPH_BLOCKED_MARKER);
    expect(blocked).toBeDefined();
    expect(blocked!.id).toBe(EMPEROR_SESSION);
    expect(blocked!.noReply).toBe(false); // wakes the orchestrator for the approval gate
    const blockedState = ts["getEntry"](graph_id).runtime.status();
    expect(blockedState.nodes.get("G")!.status).toBe("blocked");

    // Execute the compiled graph_approve tool (the Pi-compiled execute()
    // surface — same PiToolFactory.compileAll pipeline the stack uses) bound
    // to the SAME toolset, with action=approve.
    const compiledApprove = new PiToolFactory().compileAll({
      graph_approve: createGraphApproveTool(ts),
    })["graph_approve"] as any;
    const approveOut = await exec(compiledApprove, {
      graph_id,
      node_id: "G",
      action: "approve",
    });
    expect(parse(approveOut).graph_id).toBe(graph_id);
    await flush();

    // The gate resolved: node completed, graph complete, [GRAPH COMPLETE] follows.
    const after = ts["getEntry"](graph_id).runtime.status();
    expect(after.nodes.get("G")!.status).toBe("completed");
    expect(after.phase).toBe("complete");
    expect(reminder(client, GRAPH_COMPLETE_MARKER)).toBeDefined();
  });
});

// ── (c) engine-state persistence through the compiled surface ────────────────

describe("engine-state persistence through the compiled surface", () => {
  it("writes engine-*.json under <stateDir>/.rolebox/state and graph_status(scope=persisted) lists the graph", async () => {
    const client = new FakeSessionClient();
    const manager = new StubDispatchManager();
    const stateDir = makeTmpDir();
    const stack = makeStack(client, manager, stateDir);
    await stack.init();
    const tools = stack.getHandlers().tool as Record<string, any>;

    // Drive a full run through the compiled tools.
    const created = parse(await exec(tools.graph_create, { name: "persist-e2e" }));
    await exec(tools.graph_add_node, {
      graph_id: created.graph_id,
      id: "A",
      agent: "emperor--jinyiwei--ui",
      prompt: "do",
    });
    await exec(tools.graph_run, { graph_id: created.graph_id });
    manager.completeLatest();
    await flush();

    // The write-through persistence seam materialized the engine state file
    // under `<stateDir>/.rolebox/state` (engineStatePath, engine-persistence.ts).
    const storeDir = join(stateDir, ".rolebox", "state");
    const files = existsSync(storeDir)
      ? readdirSync(storeDir).filter((f) => /^engine-.+\.json$/.test(f))
      : [];
    expect(files).toHaveLength(1);

    // The compiled graph_status with scope=persisted scans the on-disk store.
    const scan = await exec(tools.graph_status, { scope: "persisted" });
    expect(scan.content[0].text).toContain("persist-e2e");
    expect(scan.content[0].text).toContain("complete");

    // And the per-graph persisted view resolves it as well.
    const byId = await exec(tools.graph_status, {
      graph_id: created.graph_id,
      scope: "persisted",
    });
    expect(byId.content[0].text).toContain("persist-e2e");
    expect(byId.content[0].text).toContain("completed");
  });
});
