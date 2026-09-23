import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  EnginePersistence,
  serializeEngineState,
} from "../../src/graph/persistence/engine-persistence.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  recoverInterruptedGraphs,
  type RecoveryStartupReport,
} from "../../src/graph/engine/engine-startup.ts";
import {
  createStorageFormatRegistry,
  STORAGE_FORMAT_V2,
} from "../../src/graph/persistence/storage-format.ts";
import { OUTCOME_PROTOCOL } from "../../src/graph/protocol/execution-protocol.ts";
import {
  GraphEventRecorder,
  graphEventsPath,
  type GraphEventRecord,
} from "../../src/graph/engine/graph-events.ts";
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

    expect(report).toEqual({ scanned: 1, recovered: 1, degraded: [], migrationRequired: [], failed: [] });
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
    expect(report).toEqual({ scanned: 1, recovered: 0, degraded: [], migrationRequired: [], failed: [] });
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

  it("(c2) a parseable-but-field-incomplete v2 file is reported in failed[] and does not abort a valid sibling", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    fake.setTask("task-A", "completed");
    // Valid sibling first (creates the store dir + a structurally-complete v2
    // file we can reuse as the corrupt base), then a field-incomplete file.
    persistState(dir, "g-valid", singleNodeDecl("g-valid"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });
    const stateDir = stateDirFor(dir);
    const validFile = JSON.parse(
      readFileSync(join(stateDir, "engine-g-valid.json"), "utf-8"),
    ) as Record<string, unknown>;
    // Strip a required field (`nodes`): the file is valid JSON, passes the
    // version gate, but is structurally incomplete — previously this made
    // deserializeEngineState throw a TypeError and the graph permanently
    // unrecoverable.
    const { nodes: _nodes, ...incomplete } = validFile;
    writeFileSync(
      join(stateDir, "engine-incomplete.json"),
      JSON.stringify(incomplete),
      "utf-8",
    );

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });

    // The incomplete file is captured in failed[] (corrupt-to-null contract),
    // and the valid sibling still recovers — the sweep never aborts.
    expect(report.scanned).toBe(2);
    expect(report.recovered).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toContain("engine-incomplete.json");
    expect(new EnginePersistence(dir).load("g-valid")!.phase).toBe(
      EnginePhase.Complete,
    );
  });

  it("contains a dispatch failure during recovery without aborting a healthy sibling", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    // Healthy graph: its task completed during the window → clean resume.
    fake.setTask("task-A", "completed");
    persistState(dir, "g-ok", singleNodeDecl("g-ok", "a1", "healthy prompt"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });
    // Failing graph: a ready root whose launch throws mid-recovery. The
    // dispatch failure is CONTAINED inside the advancement critical section
    // (dispatch-failure containment) — the node is timed out instead of the
    // throw escaping `recover()`, so the graph still resumes and the healthy
    // sibling is unaffected.
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
    expect(report.recovered).toBe(2); // g-throw's failure is contained, not aborted
    expect(report.failed).toHaveLength(0);
    expect(new EnginePersistence(dir).load("g-ok")!.phase).toBe(
      EnginePhase.Complete,
    );
    expect(new EnginePersistence(dir).load("g-throw")!.phase).toBe(
      EnginePhase.Complete,
    );
  });

  it("(e) reports a reconcile failure as degraded, never as recovered (B3)", async () => {
    const dir = makeTmpDir();
    // A `running` node with NO dispatchTaskId sends reconcile into the
    // crash-window orphan sweep (`getTasksByParent`). A dispatch store that
    // throws there makes `reconcileEngine` throw — the failure `recover()`
    // contains and answers as `degraded`.
    class ThrowingParentSweep extends FakeManager {
      getTasksByParent(): DispatchTask[] {
        throw new Error("dispatch parent sweep exploded");
      }
    }
    const fake = new ThrowingParentSweep();
    persistState(dir, "g-degraded", singleNodeDecl("g-degraded"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
    });

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
    });

    expect(report.scanned).toBe(1);
    // B3: the state was adopted but reconciliation failed — NOT a clean resume.
    expect(report.recovered).toBe(0);
    expect(report.degraded).toHaveLength(1);
    expect(report.degraded[0]).toContain("engine-g-degraded.json");
    expect(report.degraded[0]).toContain("g-degraded");
    expect(report.degraded[0]).toContain("dispatch parent sweep exploded");
    // A contained reconcile failure is not a hard failure.
    expect(report.failed).toEqual([]);
    // The degraded path returns before the final persist, so the graph is NOT
    // rewritten as complete — a later sweep can retry it.
    expect(new EnginePersistence(dir).load("g-degraded")!.phase).toBe(
      EnginePhase.Executing,
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

    expect(report).toEqual({ scanned: 0, recovered: 0, degraded: [], migrationRequired: [], failed: [] });
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
    expect(report).toEqual({ scanned: 0, recovered: 0, degraded: [], migrationRequired: [], failed: [] });
  });
});

// ── Observer seams (monitor S10) ─────────────────────────────────────────────

/** Read + parse every NDJSON line from a graph's event log ([] if absent). */
function readEventLines(dir: string, graphId: string): GraphEventRecord[] {
  const path = graphEventsPath(dir, graphId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GraphEventRecord);
}

describe("recoverInterruptedGraphs — observer seam passthrough (S10)", () => {
  it("a recovered engine wired with graphEvents continues writing node_completed lines", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    // The node's task finished during the restart window → recovery re-emits
    // its (inferred) `answer` and completes the graph.
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
      // Monitor (S10): the same GraphEventRecorder (same stateDir) the live
      // engine used → the recovered engine CONTINUES the audit log.
      graphEvents: new GraphEventRecorder(dir),
    });

    // Report semantics unchanged by the observer wiring.
    expect(report).toEqual({ scanned: 1, recovered: 1, degraded: [], migrationRequired: [], failed: [] });

    // The recovered engine wrote the node's terminal transition into the log.
    const lines = readEventLines(dir, "g-exec");
    const completed = lines.find((l) => l.event === "node_completed");
    expect(completed).toBeDefined();
    expect(completed!.graphId).toBe("g-exec");
    expect(completed!.nodeId).toBe("A");
    expect(completed!.signalType).toBe("answer");
    expect(completed!.status).toBe(NodeStatus.Completed);
    // And the lifecycle advanced to terminal — phase_change → complete.
    expect(
      lines.some((l) => l.event === "phase_change" && l.status === "complete"),
    ).toBe(true);
  });

  it("forwards onNodeCompletion and onGraphTerminal onto the recovered engine", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
    fake.setTask("task-A", "completed");
    persistState(dir, "g-exec", singleNodeDecl("g-exec"), {
      phase: EnginePhase.Executing,
      nodeStatus: NodeStatus.Running,
      taskId: "task-A",
    });

    const completions: Array<{ graphId: string; nodeId: string; signalType: string }> = [];
    const terminals: Array<{ graphId: string; phase: string; isBlocked: boolean }> = [];
    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: fake as unknown as DispatchManager,
      stateDir: dir,
      onNodeCompletion: (event) => {
        completions.push({
          graphId: event.graphId,
          nodeId: event.nodeId,
          signalType: event.signalType,
        });
      },
      onGraphTerminal: (event) => {
        terminals.push({
          graphId: event.graphId,
          phase: event.phase,
          isBlocked: event.isBlocked,
        });
      },
    });

    expect(report).toEqual({ scanned: 1, recovered: 1, degraded: [], migrationRequired: [], failed: [] });
    // The recovered node's completion re-announced through the seam.
    expect(completions).toContainEqual({
      graphId: "g-exec",
      nodeId: "A",
      signalType: "answer",
    });
    // The graph reached COMPLETE and the terminal seam fired once.
    expect(terminals).toEqual([
      { graphId: "g-exec", phase: "complete", isBlocked: false },
    ]);
  });

  it("without the new observer options the sweep behaves exactly as before", async () => {
    const dir = makeTmpDir();
    const fake = new FakeManager();
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
      // No onNodeCompletion / onGraphTerminal / graphEvents → old behavior.
    });

    expect(report).toEqual({ scanned: 1, recovered: 1, degraded: [], migrationRequired: [], failed: [] });
    // No event log is produced (the recorder is only constructed when wired).
    expect(existsSync(graphEventsPath(dir, "g-exec"))).toBe(false);
    // The engine state itself still recovered to terminal.
    expect(new EnginePersistence(dir).load("g-exec")!.phase).toBe(
      EnginePhase.Complete,
    );
  });
});

// ── Storage-format buckets (B stage): unsupported vs migration-required ──────
//
// The sweep must not conflate a file it cannot DECODE with one it merely cannot
// EXECUTE yet: an unknown numeric storage version is a build limitation and
// lands in `failed[]` as `unsupported storage`, while a version with a
// REGISTERED migration is intact data that lands in `migrationRequired[]` — a
// bucket counted as neither recovered nor failed. An ILLEGAL version
// identifier (not a positive safe integer) is neither: it is a malformed
// discriminator and lands in `failed[]` as `corrupt storage`.

describe("recoverInterruptedGraphs — storage-format buckets (B stage)", () => {
  /**
   * Write a valid executing single-node snapshot whose `version` header is an
   * arbitrary value — an on-disk file this build cannot decode.
   */
  function persistVersionedFile(
    dir: string,
    graphId: string,
    file: string,
    version: unknown,
  ): string {
    const state = createEngineState(singleNodeDecl(graphId), graphId);
    provision(state);
    state.phase = EnginePhase.Executing;
    const dto: Record<string, unknown> = JSON.parse(
      JSON.stringify(serializeEngineState(state)),
    );
    dto.version = version;
    const stateDir = stateDirFor(dir);
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, file);
    writeFileSync(path, JSON.stringify(dto), "utf-8");
    return path;
  }

  it("an unknown numeric storage version is reported in failed[] as unsupported, not skipped", async () => {
    const dir = makeTmpDir();
    const path = persistVersionedFile(dir, "g-unknown", "engine-unknown.json", 7);

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: manager(),
      stateDir: dir,
    });

    expect(report.scanned).toBe(1);
    expect(report.recovered).toBe(0);
    expect(report.migrationRequired).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toContain("engine-unknown.json");
    expect(report.failed[0]).toContain("unsupported storage: 7");
    // Intact data is never rewritten: the file still carries its version.
    expect(JSON.parse(readFileSync(path, "utf-8")).version).toBe(7);
  });

  it("an illegal version identifier is reported as corrupt storage, not unsupported", async () => {
    const dir = makeTmpDir();
    const path = persistVersionedFile(
      dir,
      "g-fractional",
      "engine-fractional.json",
      2.5,
    );

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: manager(),
      stateDir: dir,
    });

    expect(report.scanned).toBe(1);
    expect(report.recovered).toBe(0);
    expect(report.migrationRequired).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toContain("engine-fractional.json");
    // The label carries the axis and names what was received — the mirror of
    // `unsupported <dimension>: <detail>` above.
    expect(report.failed[0]).toContain(
      "corrupt storage: storage format version is the non-integer number 2.5",
    );
    // Intact data is never rewritten: the file still carries its version.
    expect(JSON.parse(readFileSync(path, "utf-8")).version).toBe(2.5);
  });

  it("a registered migration capability lands in migrationRequired[], recovered nowhere", async () => {
    const dir = makeTmpDir();
    const path = persistVersionedFile(
      dir,
      "g-migratable",
      "engine-migratable.json",
      7,
    );
    // A migration CAPABILITY (source validation included), not list
    // membership: the sweep routes an intact registered predecessor into
    // `migrationRequired[]` and never hydrates it here.
    const registry = createStorageFormatRegistry({
      current: STORAGE_FORMAT_V2,
      decoders: DEFAULT_STORAGE_FORMAT_REGISTRY.decoders,
      migrations: [
        {
          from: 7,
          to: STORAGE_FORMAT_V2,
          validateSource: () => ({ ok: true }),
          migrate: (parsed) => parsed,
        },
      ],
    });

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: manager(),
      stateDir: dir,
      storageFormatRegistry: registry,
    });

    expect(report.scanned).toBe(1);
    // Neither a clean resume nor a failure: the snapshot is intact but not
    // executable until the registered conversion commits.
    expect(report.recovered).toBe(0);
    expect(report.failed).toEqual([]);
    expect(report.migrationRequired).toHaveLength(1);
    expect(report.migrationRequired[0]).toContain("engine-migratable.json");
    expect(report.migrationRequired[0]).toContain(
      "migration-required storage: 7 -> 2",
    );
    // NOT silently skipped: it is reported, and its body was neither hydrated
    // nor rewritten (the file is still the version-7 snapshot written above).
    expect(JSON.parse(readFileSync(path, "utf-8")).version).toBe(7);
  });
});

// ── Execution-protocol routing (B3, C3c) ────────────────────────────────────
//
// The sweep reports every non-valid load result by its DIMENSION, so a protocol
// this build has no handler for lands in failed[] as `unsupported execution`.
// Since C3b the OUTCOME protocol IS registered, so a declared graph loads as
// valid — and since C3c it is routed to the OUTCOME run path, which resumes it
// from the persisted plan and the ledger state. A protocol-2 record that path
// CANNOT resume (here: one carrying no compiled plan, because it was not written
// by graph_declare) is reported explicitly in `outcomeProtocol.refused`, is
// never handed to the legacy engine and is left byte-for-byte as it was. A
// resumable declared graph is covered end to end in
// tests/graph/outcome-recovery.test.ts.

describe("recoverInterruptedGraphs — execution-protocol routing (B3, C3c)", () => {
  it("reports an un-resumable outcome-protocol state explicitly and never resumes it under legacy rules", async () => {
    const dir = makeTmpDir();
    const state = createEngineState(singleNodeDecl("g-proto2"), "g-proto2");
    provision(state);
    state.phase = EnginePhase.Executing;
    const dto: Record<string, unknown> = JSON.parse(
      JSON.stringify(serializeEngineState(state)),
    );
    dto.executionProtocolVersion = OUTCOME_PROTOCOL;
    const stateDir = stateDirFor(dir);
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, "engine-proto2.json");
    writeFileSync(path, JSON.stringify(dto), "utf-8");

    const report = await recoverInterruptedGraphs({
      directory: dir,
      manager: manager(),
      stateDir: dir,
    });

    expect(report.scanned).toBe(1);
    expect(report.recovered).toBe(0);
    expect(report.degraded).toEqual([]);
    expect(report.migrationRequired).toEqual([]);
    // Not `failed[]`: the record is valid, it is the RESUME that is refused, so
    // it lands in the outcome protocol's own refusal bucket.
    expect(report.failed).toEqual([]);
    expect(report.outcomeProtocol).toBeDefined();
    expect(report.outcomeProtocol?.refused).toHaveLength(1);
    expect(report.outcomeProtocol?.refused[0]).toContain("engine-proto2.json");
    expect(report.outcomeProtocol?.refused[0]).toContain("missing-persisted-plan");
    // Nothing was started or dispatched: a graph whose plan is absent is never
    // recompiled and never rebuilt from the legacy declaration carrier.
    expect(report.outcomeProtocol?.started).toEqual([]);
    expect(report.outcomeProtocol?.resumed).toEqual([]);
    expect(report.outcomeProtocol?.dispatched).toEqual([]);
    // Refused, not downgraded: the snapshot keeps its protocol identity and
    // was neither hydrated nor rewritten.
    const after: Record<string, unknown> = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    expect(after.phase).toBe(EnginePhase.Executing);
  });
});

