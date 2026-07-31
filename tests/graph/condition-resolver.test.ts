import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  NodeRuntimeState,
  EngineState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type EdgeConditionResolver,
} from "../../src/graph/engine/engine-advance.ts";
import defaultConditionResolver from "../../src/graph/engine/condition-resolver.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal running source node with the given observed signals. */
function makeSource(signals: Record<string, unknown> = {}): NodeRuntimeState {
  return {
    nodeId: "A",
    agent: "a1",
    prompt: "p1",
    needsApproval: false,
    status: NodeStatus.Running,
    signalsObserved: signals,
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: false,
    traversalCount: 0,
    startedAt: 0,
    retryCount: 0,
  };
}

// Temp artifact for the artifact_exists checks. These are created in beforeAll —
// NOT at module scope — so no filesystem write runs during module
// evaluation/collection. The resolver resolves artifact_exists names relative to
// process.cwd() (src/graph/engine/condition-resolver.ts joins the name onto
// process.cwd()). To exercise that contract we must hand it a name that is
// GENUINELY relative to cwd on every platform:
//   - The artifact must live under process.cwd() so that relative(cwd, presentFile)
//     always yields a relative path, never an absolute one.
//   - On win32, if the artifact lived in os.tmpdir() (as it did before), a
//     cross-drive relative() returns an ABSOLUTE path (Node's documented behavior
//     when from/to are on different drives), which breaks the resolver's
//     join(process.cwd(), arg) reconstruction and fails in CI.
// So we create the temp dir under cwd, guaranteeing same-drive / cwd-prefixed
// paths and a platform-neutral relative() result (backslash separators on win32
// are normalized correctly by path.join).
let cwdArtifact: string;
let presentFile: string;
let missingFile: string; // never created

beforeAll(() => {
  cwdArtifact = mkdtempSync(join(process.cwd(), ".rb-cond-test-"));
  presentFile = join(cwdArtifact, "report.md");
  writeFileSync(presentFile, "present");
  missingFile = join(cwdArtifact, "nope.md"); // never created
});

afterAll(() => {
  if (cwdArtifact) rmSync(cwdArtifact, { recursive: true, force: true });
});

// ── Fake dispatch seam (injectable into createEngine) ───────────────────────

class FakeDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string }[] = [];
  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({
      nodeId: node.nodeId,
      agent: node.agent,
      prompt: node.prompt,
    });
    return Promise.resolve(makeTask(node.nodeId));
  }
}

function makeTask(nodeId: string): DispatchTask {
  return {
    id: `task-${nodeId}`,
    sessionId: `sess-${nodeId}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: nodeId,
    prompt: nodeId,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

// ── defaultConditionResolver: condition vocabulary ──────────────────────────

describe("defaultConditionResolver", () => {
  it("signal_observed(<type>) is true when the signal is recorded", () => {
    const source = makeSource({ answer: "done", progress: "working" });
    expect(defaultConditionResolver("signal_observed(answer)", source)).toBe(true);
    expect(defaultConditionResolver("signal_observed(progress)", source)).toBe(true);
  });

  it("signal_observed(<type>) is false when the signal is NOT recorded", () => {
    const source = makeSource({ answer: "done" });
    expect(defaultConditionResolver("signal_observed(escalate)", source)).toBe(false);
    expect(defaultConditionResolver("signal_observed(foo)", source)).toBe(false);
  });

  it("signal_observed requires a non-empty arg", () => {
    const source = makeSource({ "": "x" });
    expect(defaultConditionResolver("signal_observed()", source)).toBe(false);
  });

  it("artifact_exists(<name>) is true for an existing file relative to cwd", () => {
    const source = makeSource();
    // Pass a name RELATIVE to cwd — the resolver joins it onto process.cwd().
    const rel = relative(process.cwd(), presentFile);
    expect(existsSync(presentFile)).toBe(true);
    expect(defaultConditionResolver(`artifact_exists(${rel})`, source)).toBe(true);
  });

  it("artifact_exists(<name>) is false for a missing file", () => {
    const source = makeSource();
    const rel = relative(process.cwd(), missingFile);
    expect(defaultConditionResolver(`artifact_exists(${rel})`, source)).toBe(false);
  });

  it("artifact_exists requires a non-empty arg", () => {
    const source = makeSource();
    expect(defaultConditionResolver("artifact_exists()", source)).toBe(false);
  });

  it("unknown conditions evaluate false", () => {
    const source = makeSource({ answer: "done" });
    // Not in the vocabulary at all.
    expect(defaultConditionResolver("mystery_condition()", source)).toBe(false);
    // Bare name without a call shape.
    expect(defaultConditionResolver("signal_observed", source)).toBe(false);
    // Condition that exists in the shared conditions.ts vocabulary but depends
    // on a CondEnv/FnState the engine does not have → unsupported → false.
    expect(defaultConditionResolver("user_approval()", source)).toBe(false);
    expect(defaultConditionResolver("tool_observed(grep)", source)).toBe(false);
  });
});

// ── createEngine wiring: default resolver injected on on_condition edges ────

function conditionGraph(condition: string): GraphDeclaration {
  return {
    version: 2,
    name: "cond",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "A", to: "B", type: "on_condition", condition }],
  };
}

/**
 * Build an engine the exact way `createEngine`'s constructor wires it (see
 * `src/graph/engine/index.ts`): `conditionResolver: opts.conditionResolver ??
 * defaultConditionResolver`. The public `EngineRuntime` surface does not yet
 * expose signal emission (external integration is a Phase 3 subtask), so we
 * drive the same resolver-injection wiring through `AdvanceEngine`'s public
 * `onNodeSignalEmitted` entry — reproducing createEngine's constructor exactly
 * rather than duplicating it.
 */
function buildWired(
  decl: GraphDeclaration,
  fake: FakeDispatch,
  resolver: EdgeConditionResolver = defaultConditionResolver,
) {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  // Mirrors createEngine: explicit resolver wins, else the default resolver.
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: fake,
    conditionResolver: resolver,
  });
  return { state, engine };
}

describe("on_condition edge activation (createEngine default wiring)", () => {
  it("activates the edge when the condition evaluates true", async () => {
    const fake = new FakeDispatch();
    const { engine, state } = buildWired(conditionGraph("signal_observed(answer)"), fake);

    await engine.dispatchReady(); // dispatch root A
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);

    await engine.onNodeSignalEmitted("A", "answer", "result-A");

    // B was activated (ready → running) via the on_condition edge.
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A", "B"]);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.joinSatisfied).toBe(true);
  });

  it("does NOT activate the edge when the condition evaluates false", async () => {
    const fake = new FakeDispatch();
    const { engine, state } = buildWired(conditionGraph("signal_observed(escalate)"), fake);

    await engine.dispatchReady();
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);

    await engine.onNodeSignalEmitted("A", "answer", "result-A");

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    // B never activated — the conditional edge didn't fire, so B was never
    // dispatched.
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);
    // B's join was never satisfied and no running/ready/blocked upstream or
    // deferred completion can ever satisfy it → the runtime deadlock guard
    // escalates B and terminates the graph (was previously an infinite hang in
    // `executing`).
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("B")!.errorReason).toContain("graph deadlock");
    expect(state.phase).toBe(EnginePhase.Complete);
  });

  it("honors a caller-supplied resolver override", async () => {
    const fake = new FakeDispatch();
    const { engine } = buildWired(
      conditionGraph("signal_observed(escalate)"),
      fake,
      () => true, // always-true override ignores the declared condition
    );
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "result-A");
    // Override forces activation despite the condition nominally being false.
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A", "B"]);
  });
});
