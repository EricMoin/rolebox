/**
 * Outcome-protocol handler registration (C3b).
 *
 * The execution-protocol registry now holds a REAL handler for protocol 2, so a
 * declared graph becomes loadable AND runnable in the same slice. This file
 * verifies the three halves of that boundary together: the shipped registry
 * binds protocol 2 through the outcome CAPABILITY (not the number), a declared
 * graph loads through the loader as valid, the legacy entry points still refuse
 * it without dispatching anything, and its compiled plan runs through the
 * outcome run path instead. It also proves a handler registered under 2 that
 * does not declare the outcome capability is refused rather than trusted, and
 * that the legacy RUNTIME's own resume entry (`EngineRuntime.recover()`)
 * refuses the record instead of adopting it under legacy rules.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
  OutcomeProtocolUnavailableError,
} from "../../src/graph/tools/declare-graph.ts";
import {
  DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
  LEGACY_EXECUTION_PROTOCOL_REGISTRY,
  LEGACY_SIGNAL_PROTOCOL,
  OUTCOME_PROTOCOL,
  OUTCOME_PROTOCOL_HANDLER,
  classifyExecutionProtocol,
  createExecutionProtocolRegistry,
  isOutcomeProtocolHandler,
} from "../../src/graph/protocol/execution-protocol.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStatePath,
  loadEngineStateForResume,
} from "../../src/graph/engine/engine-persistence.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { createEngine } from "../../src/graph/engine/index.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "graph.protocol",
  nodes: [
    {
      id: "plan",
      agent: "agent.plan",
      prompt: "Plan the work.",
      outcomes: [{ id: "planned" }],
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship the work.",
      outcomes: [{ id: "shipped" }],
    },
  ],
  edges: [{ from: "plan", to: "ship", outcome: "planned" }],
};

/** A dispatch seam that records calls and never completes anything. */
class CountingDispatch implements NodeDispatchPort {
  calls = 0;
  executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
    this.calls += 1;
    return Promise.resolve({
      id: "task-" + node.nodeId,
      sessionId: "sess-" + node.nodeId,
      parentSessionId: "g",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    });
  }
}

// ── The registered handler ──────────────────────────────────────────────────

describe("execution-protocol registry — the outcome handler (C3b)", () => {
  it("binds protocol 2 through the outcome CAPABILITY, not the number", () => {
    const verdict = classifyExecutionProtocol(
      OUTCOME_PROTOCOL,
      DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
    );
    expect(verdict.kind).toBe("bound");
    if (verdict.kind !== "bound") return;
    // The verdict carries the SAME frozen handler the registry holds.
    expect(verdict.handler).toBe(OUTCOME_PROTOCOL_HANDLER);
    expect(isOutcomeProtocolHandler(verdict.handler)).toBe(true);
    // What the handler OWNS, declared rather than assumed.
    expect(OUTCOME_PROTOCOL_HANDLER.completion).toBe("accepted-outcome-submission");
    expect(OUTCOME_PROTOCOL_HANDLER.submissionIngress).toBe(
      "graph-scoped-outcome-submission",
    );
    expect(OUTCOME_PROTOCOL_HANDLER.legacyCompletion).toBe("unreachable");
    // Both protocols are shipped; the legacy-only registry still refuses 2.
    expect(
      DEFAULT_EXECUTION_PROTOCOL_REGISTRY.handlers.map((handler) => handler.version),
    ).toEqual([LEGACY_SIGNAL_PROTOCOL, OUTCOME_PROTOCOL]);
    expect(
      classifyExecutionProtocol(OUTCOME_PROTOCOL, LEGACY_EXECUTION_PROTOCOL_REGISTRY),
    ).toEqual({ kind: "unsupported", version: OUTCOME_PROTOCOL });
    // Frozen membership: an in-place widening cannot make the set move.
    expect(Object.isFrozen(DEFAULT_EXECUTION_PROTOCOL_REGISTRY)).toBe(true);
    expect(Object.isFrozen(OUTCOME_PROTOCOL_HANDLER)).toBe(true);
  });

  it("refuses a handler registered under 2 that does not declare the outcome capability", async () => {
    // A bare marker is not an outcome handler, and the runtime says so instead
    // of running the graph under semantics nobody declared.
    const markerOnly = createExecutionProtocolRegistry({
      handlers: [{ version: LEGACY_SIGNAL_PROTOCOL }, { version: OUTCOME_PROTOCOL }],
    });
    const verdict = classifyExecutionProtocol(OUTCOME_PROTOCOL, markerOnly);
    expect(verdict.kind).toBe("bound");
    if (verdict.kind !== "bound") return;
    expect(isOutcomeProtocolHandler(verdict.handler)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "outcome-handler-"));
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      const runtime = new OutcomeGraphRuntime({
        plan: graph.plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        protocols: markerOnly,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("refused");
      if (started.kind !== "refused") return;
      expect(started.refusals.map((refusal) => refusal.code)).toContain(
        "protocol-unavailable",
      );
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Load, legacy refusal, and the run path in one graph ─────────────────────

describe("a declared graph loads, refuses legacy entry points, and runs its plan", () => {
  it("does all three against the same persisted declaration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outcome-protocol-graph-"));
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      expect(persistDeclaredGraph(graph, dir)).toBe(true);

      // 1. LOADS through the loader as valid, naming the outcome protocol.
      const loaded = loadEngineStateForResume(
        readFileSync(engineStatePath(dir, "graph.protocol"), "utf-8"),
        engineStatePath(dir, "graph.protocol"),
        DEFAULT_STORAGE_FORMAT_REGISTRY,
        DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
      );
      expect(loaded.kind).toBe("valid");
      if (loaded.kind === "valid") {
        expect(loaded.executionProtocol).toBe(OUTCOME_PROTOCOL);
        expect(loaded.state.compiledPlan?.planRevision).toBe(graph.plan.planRevision);
      }

      // 2. REFUSES every legacy entry point, dispatching nothing.
      const dispatch = new CountingDispatch();
      const ts = createGraphToolSet({ dispatch, stateDir: dir });
      await expect(
        ts.graph_run({ graph_id: "graph.protocol" }),
      ).rejects.toThrow(OutcomeProtocolUnavailableError);
      expect(dispatch.calls).toBe(0);
      let caught: unknown;
      try {
        await ts.graph_run({ graph_id: "graph.protocol" });
      } catch (error) {
        caught = error;
      }
      if (caught instanceof OutcomeProtocolUnavailableError) {
        expect(caught.graphId).toBe("graph.protocol");
        expect(caught.planRevision).toBe(graph.plan.planRevision);
        expect(caught.message).toMatch(/OUTCOME run path/);
        expect(caught.message).toMatch(/Nothing was dispatched/);
      } else {
        throw new Error("expected OutcomeProtocolUnavailableError, got " + String(caught));
      }

      // 3. RUNS its plan through the outcome run path instead. Each dispatch
      // hands the worker the attempt credential it must present back.
      const requests: string[] = [];
      const credentials = new Map<string, string>();
      const runtime = new OutcomeGraphRuntime({
        plan: graph.plan,
        ledger,
        dispatch: (request) => {
          requests.push(request.nodeId + ":" + request.attemptId);
          credentials.set(request.attemptId, request.credential);
        },
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
      });
      /** The credential one dispatched attempt was handed, for the submission. */
      const credentialOf = (attemptId: string): string => {
        const found = credentials.get(attemptId);
        if (found === undefined) {
          throw new Error("fixture: no dispatch request for attempt " + attemptId);
        }
        return found;
      };
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(requests).toEqual(["plan:plan#1"]);

      const advanced = runtime.submit(
        { nodeId: "plan", outcomeId: "planned", credential: credentialOf("plan#1") },
        NOW + 1,
      );
      expect(advanced.kind).toBe("accepted");
      if (advanced.kind !== "accepted") return;
      expect(requests).toEqual(["plan:plan#1", "ship:ship#2"]);

      const done = runtime.submit(
        { nodeId: "ship", outcomeId: "shipped", credential: credentialOf("ship#2") },
        NOW + 2,
      );
      expect(done.kind).toBe("accepted");
      if (done.kind !== "accepted") return;
      expect(done.state.phase).toBe("complete");
      // The graph's state lives in the LEDGER, not in a JSON file beside it.
      expect(ledger.readGraphState("graph.protocol")?.planRevision).toBe(
        graph.plan.planRevision,
      );
      expect(ledger.acceptedEvents("graph.protocol")).toHaveLength(2);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The legacy runtime's recover() must not adopt a declared state ──────────

describe("EngineRuntime.recover() refuses an outcome-protocol record (C3b)", () => {
  it("adopts nothing, dispatches nothing and leaves the record byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outcome-recover-"));
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      expect(persistDeclaredGraph(graph, dir)).toBe(true);
      const path = engineStatePath(dir, "graph.protocol");
      const before = readFileSync(path, "utf-8");

      // A LEGACY runtime for the very same graph id and state directory. With
      // the outcome handler registered, the record now LOADS as valid — so the
      // adoption gate must be the protocol identity, not the loader.
      const dispatch = new CountingDispatch();
      const engine = createEngine(
        { version: 2, name: "graph.protocol", nodes: [], edges: [] },
        { graphId: "graph.protocol", stateDir: dir, dispatch },
      );
      const report = await engine.recover();

      // The legacy recovery path reports the refusal instead of adopting.
      expect(report.status).toBe("protocol_refused");
      if (report.status === "protocol_refused") {
        expect(report.executionProtocol).toBe(OUTCOME_PROTOCOL);
      }
      // Nothing was dispatched and no declared node entered the legacy runtime.
      expect(dispatch.calls).toBe(0);
      expect([...engine.status().nodes.keys()]).toEqual([]);
      // No write happened on this path: the record keeps its protocol, plan
      // and binding exactly as the declaration wrote them.
      expect(readFileSync(path, "utf-8")).toBe(before);
      engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
