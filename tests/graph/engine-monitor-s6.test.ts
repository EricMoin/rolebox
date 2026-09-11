/**
 * Graph Execution Engine v2 — Monitor Observation Mechanism (subtask S6)
 *
 * Verifies the monitor repair plan over `engine-state.ts` and
 * `dispatch-bridge.ts`:
 *
 * - M2 — a node's declared per-node budget is carried into runtime state
 *   (`registerNode` shallow-clones `config.budget` → `node.budget`) and the
 *   declared `timeout_ms` actually reaches the dispatched task:
 *   `DispatchBridge.executeNode` sources `DispatchInput.timeout_ms` from
 *   `node.budget?.timeout_ms`, and the task-launcher consumes it into
 *   `task.timeoutMs` (monitor-audit F7: the declared timeout was previously
 *   written to the declaration but never consumed — no real dispatch task was
 *   ever bounded by it).
 * - M4 — `DispatchBridge.removeTaskTerminatedListener` delegates to
 *   `DispatchManager.removeTaskTerminatedListener`, so a registered
 *   task-terminated listener can actually be unregistered before the task
 *   reaches a terminal state (closes the leak that fire-once subscriptions
 *   would otherwise leave on the manager).
 *
 * These tests drive the REAL DispatchManager → task-launcher path over a stub
 * ISessionClient (same rig as `session-create-launch.test.ts`), NOT the fake
 * NodeDispatchPort used by the other graph tests — the fake would silently
 * pass regardless of the bridge's wiring.
 */

import { describe, it, expect, mock } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import {
  DispatchBridge,
  graphParentContext,
} from "../../src/graph/engine/dispatch-bridge";
import {
  createEngineState,
  registerNode,
} from "../../src/graph/engine/engine-state";
import type { GraphDeclaration } from "../../src/types.graph-v2";
import { createMockClient, parentContext } from "../dispatch/helpers";

const WORKDIR = "/work/dir-for-engine-monitor-s6";

const fastConfig = {
  maxConcurrent: 5,
  taskTtlMs: 5_000,
};

/** Minimal single-node declaration, optionally carrying a per-node budget. */
function singleNode(budget?: { timeout_ms?: number }): GraphDeclaration {
  return {
    version: 2,
    name: "m6",
    nodes: [
      {
        id: "A",
        agent: "a1",
        prompt: "p1",
        ...(budget ? { budget } : {}),
      },
    ],
    edges: [],
  };
}

// ── M2: declared per-node budget → runtime state → dispatch task timeout ────

describe("M2 — per-node budget carrier (registerNode) and timeout flow (executeNode)", () => {
  it("registerNode shallow-clones the declared budget into node.budget", () => {
    const decl = singleNode({ timeout_ms: 42_000 });
    const state = createEngineState(decl, "g-m2-clone");
    const node = registerNode(state, decl.nodes[0]);

    expect(node.budget).toEqual({ timeout_ms: 42_000 });
    // Clone, not aliasing: mutating the declaration must not leak into the
    // runtime carrier.
    expect(node.budget).not.toBe(decl.nodes[0].budget);
    (decl.nodes[0].budget as { timeout_ms: number }).timeout_ms = 999;
    expect(node.budget!.timeout_ms).toBe(42_000);
  });

  it("registerNode leaves node.budget undefined when no budget is declared", () => {
    const decl = singleNode();
    const state = createEngineState(decl, "g-m2-none");
    const node = registerNode(state, decl.nodes[0]);

    expect(node.budget).toBeUndefined();
  });

  it("executeNode propagates node.budget.timeout_ms into the dispatched task.timeoutMs", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const bridge = new DispatchBridge(manager);
    try {
      const decl = singleNode({ timeout_ms: 42_000 });
      const state = createEngineState(decl, "g-m2-flow");
      const node = registerNode(state, decl.nodes[0]);

      const task = await bridge.executeNode(
        node,
        graphParentContext({ graphId: "g-m2-flow", directory: WORKDIR }),
      );

      // The declared timeout must bound the actual dispatch task.
      expect(task.timeoutMs).toBe(42_000);
    } finally {
      await manager.dispose();
    }
  });

  it("executeNode omits timeout_ms (task falls back to the default) when no budget is declared", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const bridge = new DispatchBridge(manager);
    try {
      const decl = singleNode();
      const state = createEngineState(decl, "g-m2-default");
      const node = registerNode(state, decl.nodes[0]);

      const task = await bridge.executeNode(
        node,
        graphParentContext({ graphId: "g-m2-default", directory: WORKDIR }),
      );

      expect(task.timeoutMs).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });
});

// ── M4: removeTaskTerminatedListener passthrough ────────────────────────────

describe("M4 — DispatchBridge.removeTaskTerminatedListener", () => {
  it("registered listener fires on completion (positive control)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const bridge = new DispatchBridge(manager);
    try {
      const task = await bridge.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const cb = mock((_taskId: string, _status: string) => {});
      bridge.onTaskTerminated(task.id, cb);

      await (manager as unknown as { handleTaskCompleted: (id: string) => Promise<void> }).handleTaskCompleted(task.id);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(task.id, "completed");
    } finally {
      await manager.dispose();
    }
  });

  it("removes a registered listener so it never fires on completion", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);
    const bridge = new DispatchBridge(manager);
    try {
      const task = await bridge.launch(
        { subagent: "helper", prompt: "work", run_in_background: true },
        parentContext(),
      );

      const cb = mock((_taskId: string, _status: string) => {});
      bridge.onTaskTerminated(task.id, cb);
      // The passthrough under test: this must reach the manager's listener set.
      bridge.removeTaskTerminatedListener(task.id, cb);

      await (manager as unknown as { handleTaskCompleted: (id: string) => Promise<void> }).handleTaskCompleted(task.id);

      expect(cb).not.toHaveBeenCalled();
      // The manager's listener set for the task is gone — the passthrough
      // actually removed the registration (matches manager.test.ts's own
      // internal assertion at line 5236).
      expect(
        (manager as unknown as { taskTerminatedListeners: Map<string, Set<unknown>> })
          .taskTerminatedListeners.has(task.id),
      ).toBe(false);
    } finally {
      await manager.dispose();
    }
  });
});
