import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  recoverInterruptedGraphs,
  type RecoveryStartupReport,
} from "../../src/graph/engine/engine-startup.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

// ── Test double: a structural DispatchManager fake ────────────────────────────

function makeTask(id: string, status: DispatchTask["status"] = "running"): DispatchTask {
  return {
    id,
    sessionId: `sess-${id}`,
    parentSessionId: "startup",
    depth: 1,
    status,
    agent: "a",
    prompt: "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

/**
 * Minimal fake that satisfies the `DispatchManager` *surface* `recover()`
 * touches (`getTask`, `launch`, `onTaskTerminated`, `getBudgetTracker`). Cast
 * to the concrete class type because a full manager is far too heavy for a
 * unit test. `launch` throws for any node prompt containing "THROW", giving a
 * deterministic per-graph recovery failure.
 */
class FakeManager {
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;

  setTask(id: string, status: DispatchTask["status"]): void {
    this.tasks.set(id, makeTask(id, status));
  }

  getTask(id: string): DispatchTask | undefined {
    return this.tasks.get(id);
  }

  async launch(input: { prompt?: unknown }): Promise<DispatchTask> {
    if (typeof input.prompt === "string" && input.prompt.includes("THROW")) {
      throw new Error("launch exploded (test failure)");
    }
    const t = makeTask(`task-launch-${this.seq++}`);
    this.tasks.set(t.id, t);
    return t;
  }

  onTaskTerminated(): (id: string, status: string) => void {
    return () => {};
  }

  getBudgetTracker(): {
    isRequestBudgetExceeded: () => { exceeded: boolean };
    getRequestUsage: () => { inputTokens: number; outputTokens: number; cost: number };
  } {
    return {
      isRequestBudgetExceeded: () => ({ exceeded: false }),
      getRequestUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0 }),
    };
  }

  async cancelTask(): Promise<boolean> {
    return true;
  }
}

function manager(): DispatchManager {
  return new FakeManager() as unknown as DispatchManager;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-startup-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function singleNodeDecl(
  name: string,
  agent = "a1",
  prompt = "p1",
): GraphDeclaration {
  return {
    version: 2,
    name,
    nodes: [{ id: "A", agent, prompt }],
    edges: [],
  };
}

function stateDirFor(dir: string): string {
  return join(dir, ".rolebox", "state");
}

/** Persist a single-node engine state in a chosen phase/node status. */
function persistState(
  dir: string,
  graphId: string,
  decl: GraphDeclaration,
  opts: { phase: EnginePhase; nodeStatus: NodeStatus; taskId?: string },
): void {
  const state = createEngineState(decl, graphId);
  provision(state);
  state.phase = opts.phase;
  const node = state.nodes.get("A")!;
  node.status = opts.nodeStatus;
  if (opts.taskId) node.dispatchTaskId = opts.taskId;
  new EnginePersistence(dir).save(state);
}

/** Persist a deliberately corrupt engine file directly into the store. */
function persistCorruptFile(dir: string, file: string): void {
  const stateDir = stateDirFor(dir);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, file), "{ this is not valid json !!!", "utf-8");
}

// ── recoverInterruptedGraphs ────────────────────────────────────────────────

describe("recoverInterruptedGraphs", () => {
  it("(a) recovers a persisted executing-phase graph", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    // The node's task finished during the restart window → recovery re-emits
    // its terminating signal and completes the graph.
    fake.setTask("task-A", "completed");
    persistState(dir, "g-exec", singleNodeDecl("g-exec"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });

    expect(report).toEqual({ scanned: 1, recovered: 1, failed: [] });
    // The resumed engine persisted its terminal phase — recovery actually did work.
    const persisted = new EnginePersistence(dir).load("g-exec");
    expect(persisted!.phase).toBe(EnginePhase.Complete);
    expect(persisted!.nodes.get("A")!.status).toBe(NodeStatus.Completed);
  });

  it("(b) skips a graph whose phase is already complete", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    persistState(dir, "g-done", singleNodeDecl("g-done"), {
      phase: EnginePhase.Complete,
      nodeStatus: NodeStatus.Completed,
    });

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });

    // Scanned but neither recovered nor failed — a terminal graph is skipped.
    expect(report).toEqual({ scanned: 1, recovered: 0, failed: [] });
  });

  it("(c) a corrupt engine file does not abort recovery of a valid sibling", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    fake.setTask("task-A", "completed");
    // Valid sibling first (creates the store dir), then a corrupt file.
    persistState(dir, "g-valid", singleNodeDecl("g-valid"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });
    persistCorruptFile(dir, "engine-corrupt.json");

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });

    expect(report.scanned).toBe(2);
    expect(report.recovered).toBe(1); // the valid sibling still recovered
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toContain("engine-corrupt.json");
    // The sibling really did recover.
    expect(new EnginePersistence(dir).load("g-valid")!.phase).toBe(
      EnginePhase.Complete,
    );
  });

  it("a recover() failure in one graph does not abort a healthy sibling", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    // Healthy graph: its task completed during the window → clean resume.
    fake.setTask("task-A", "completed");
    persistState(dir, "g-ok", singleNodeDecl("g-ok", "a1", "healthy prompt"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });
    // Failing graph: a ready root whose launch throws mid-recovery.
    persistState(
      dir,
      "g-throw",
      singleNodeDecl("g-throw", "a2", "THROW"),
      { phase: EnginePhase.Executing, nodeStatus: NodeStatus.Ready },
    );

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });

    expect(report.scanned).toBe(2);
    expect(report.recovered).toBe(1); // g-ok recovered
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toContain("g-throw");
    expect(new EnginePersistence(dir).load("g-ok")!.phase).toBe(
      EnginePhase.Complete,
    );
  });

  it("(d) enabled:false returns a no-op report and never touches the store", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    persistState(dir, "g-exec", singleNodeDecl("g-exec"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      enabled: false,
      stateDir: dir,
    });

    expect(report).toEqual({ scanned: 0, recovered: 0, failed: [] });
    // The on-disk state was left untouched (still executing, not resumed).
    expect(new EnginePersistence(dir).load("g-exec")!.phase).toBe(
      EnginePhase.Executing,
    );
  });

  it("is idempotent — a second sweep skips the already-recovered graph", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    fake.setTask("task-A", "completed");
    persistState(dir, "g-exec", singleNodeDecl("g-exec"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });

    const first = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });
    expect(first.recovered).toBe(1);

    // Second pass: the first recovery persisted `complete`, so it is skipped.
    const second = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });
    expect(second.scanned).toBe(1);
    expect(second.recovered).toBe(0);
    expect(second.failed).toEqual([]);
  });

  it("returns a clean no-op when the store directory does not exist", async () => {
    const dir = makeTmpDir(); // empty — no .rolebox/state yet
    const fake = new FakeManager();
    const report: RecoveryStartupReport = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });
    expect(report).toEqual({ scanned: 0, recovered: 0, failed: [] });
  });
});
