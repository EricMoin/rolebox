/**
 * Subtask 5 — graph-level guard: genuine (non-transient) session-create launch
 * failures must NOT be masked by the bounded-retry work.
 *
 * Subtasks 3-4 added a bounded retry around `session.create` in the task
 * launcher (`createSessionWithRetry`, task-launcher.ts:154-203) plus tagged
 * server-rejection errors (`SessionCreateRejectedError`). This test proves, at
 * the GRAPH level, that the retry work never hides a REAL launch failure:
 *
 *   - Scenario A (server rejection): `create` throws a tagged
 *     SessionCreateRejectedError → the node ESCALATES honestly with the real
 *     server reason surfaced (not "empty response", not a generic mask), and
 *     `create` is called exactly ONCE (a rejection is never retried).
 *   - Scenario B (transient exhaustion): `create` throws a plain transport
 *     error on EVERY attempt → `create` is called exactly the bounded number
 *     of attempts (createRetryAttempts = 3), then the node ESCALATES with the
 *     underlying transport error surfaced (not masked, not swallowed).
 *
 * Both scenarios confirm the graph reaches a terminal phase (no hang).
 *
 * Like session-create-launch.test.ts, this drives the REAL graph →
 * DispatchManager → session-create path (a real DispatchManager over a
 * recording/exception stub ISessionClient) — NOT the fake NodeDispatchPort.
 *
 * How the escalation reaches the node (verified against the engine):
 *   - The failing task terminates `error`; `mapDispatchStatusToSignal` maps
 *     `error → escalate` with `{ error: task.error }` (engine-recovery.ts:148).
 *   - `subscribeTaskTermination` delivers the terminal transition; the
 *     manager's `onTaskTerminated` immediate-fire microtask guard fires it for
 *     an already-terminal task (manager.ts:484-514).
 *   - `markEscalated(node, _extractErrorMessage(payload))` sets
 *     `node.errorReason` = `task.error` verbatim (engine-advance.ts:506-509).
 *   - `retry_count` / `traversal_count` are ENGINE-level counters (default 0,
 *     engine-state.ts:168-170) incremented only by loop/edge-retry policy —
 *     they are NOT create-attempt counters. The bounded create attempts are
 *     asserted directly via `createCalls.length`.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import type { SessionInfo, Message, SessionStatus } from "../../src/session/types";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools";
import { SessionCreateRejectedError } from "../../src/platform/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const WORKDIR = "/work/dir-for-session-create-escalation";

/** Explicit bounded-retry budget so the test is self-documenting (defaults:
 * createRetryAttempts = 3, createRetryBackoffMs = 250). Zero backoff keeps the
 * transient-exhaustion scenario fast. */
const RETRY_CONFIG = {
  createRetryAttempts: 3,
  createRetryBackoffMs: 0,
};

/** Recorded payload of one ISessionClient.create call. */
interface CreateRecord {
  directory?: string;
  agent?: string;
  parentID?: string;
}

/**
 * Build a recording stub ISessionClient whose `create` delegates to
 * `onCreate(attempt)`. Every other method mirrors the happy-path stub in
 * session-create-launch.test.ts so the launch path is the ONLY thing that
 * differs. `onCreate` may throw (reject) or return a SessionInfo.
 */
function clientWithCreate(
  onCreate: (attempt: number) => Promise<SessionInfo | null>,
): { client: ISessionClient; createCalls: CreateRecord[] } {
  const createCalls: CreateRecord[] = [];
  const client: ISessionClient = {
    async create(options: {
      directory: string;
      agent?: string;
      parentID?: string;
    }): Promise<SessionInfo | null> {
      createCalls.push({
        directory: options.directory,
        agent: options.agent,
        parentID: options.parentID,
      });
      return onCreate(createCalls.length);
    },
    async prompt(): Promise<{ id: string } | null> {
      return { id: "scl-escalate-prompt-1" };
    },
    async promptSync(): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
      return { parts: [{ type: "text", text: "ok" }] };
    },
    async messages(): Promise<Message[]> {
      return [];
    },
    async status(): Promise<SessionStatus | null> {
      return null;
    },
    async abort(): Promise<boolean> {
      return true;
    },
    async get(): Promise<SessionInfo | null> {
      return null;
    },
    async list(): Promise<SessionInfo[]> {
      return [];
    },
    async children(): Promise<SessionInfo[]> {
      return [];
    },
    async todo(): Promise<never[]> {
      return [];
    },
    async diff(): Promise<never[]> {
      return [];
    },
    async fork(): Promise<SessionInfo | null> {
      return null;
    },
  };
  return { client, createCalls };
}

/**
 * Build a real manager + tool set bound to a stub client whose `create` calls
 * `onCreate`. Returns everything a test asserts against so `afterEach` can
 * dispose the manager's timers cleanly.
 */
function buildWorld(onCreate: (attempt: number) => Promise<SessionInfo | null>): {
  ts: ReturnType<typeof createGraphToolSet>;
  manager: DispatchManager;
  createCalls: CreateRecord[];
} {
  const { client, createCalls } = clientWithCreate(onCreate);
  const manager = new DispatchManager(client, {
    maxConcurrent: 5,
    taskTtlMs: 5_000,
    ...RETRY_CONFIG,
  });
  const ts = createGraphToolSet({ manager, directory: WORKDIR });
  return { ts, manager, createCalls };
}

/**
 * Drive graph_create + graph_add_node + graph_run through the REAL manager,
 * then poll `graph_status` until the node reaches `escalate` (the async
 * dispatch→signal delivery seam) or the timeout elapses. Returns the final
 * observed node + graph phase.
 */
async function runAndAwaitEscalation(
  ts: ReturnType<typeof createGraphToolSet>,
  graphId: string,
  nodeId: string,
  timeoutMs: number,
): Promise<{
  status: string;
  error?: string;
  retry_count: number;
  traversal_count: number;
  phase: string;
}> {
  const deadline = Date.now() + timeoutMs;
  type NodeView = {
    status: string;
    error?: string;
    retry_count: number;
    traversal_count: number;
  };
  let lastNode: NodeView = { status: "missing", retry_count: 0, traversal_count: 0 };
  let lastPhase = "";
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(
      ts.graph_status({ graph_id: graphId, format: "json" }),
    ) as {
      phase: string;
      nodes: Array<NodeView & { node_id: string }>;
    };
    const node = snapshot.nodes.find((n) => n.node_id === nodeId);
    if (node) {
      lastNode = node;
      lastPhase = snapshot.phase;
    }
    if (node && node.status === "escalate") {
      return {
        status: node.status,
        error: node.error,
        retry_count: node.retry_count,
        traversal_count: node.traversal_count,
        phase: snapshot.phase,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    status: lastNode.status,
    error: lastNode.error,
    retry_count: lastNode.retry_count,
    traversal_count: lastNode.traversal_count,
    phase: lastPhase,
  };
}

// A distinct sentinel graph name per scenario avoids cross-graph graphId reuse.
const GRAPH_A = "scl-escalate-rejection";
const GRAPH_B = "scl-escalate-transient";

// ── Test ────────────────────────────────────────────────────────────────────

describe("graph-level guard: real launch failures are NOT masked by retry work", () => {
  afterEach(async () => {
    // Managers are disposed in each test's finally (they hold timers).
  });

  it(
    "Scenario A — server rejection (SessionCreateRejectedError): node ESCALATES with the real reason, create called exactly once (not retried), graph terminates",
    async () => {
      const world = buildWorld(() => {
        // Mirrors what OpencodeSessionAdapter.create throws when the server
        // rejects (r.error), e.g. unknown parent → HTTP 400.
        return Promise.reject(
          new SessionCreateRejectedError("parent session not found", "BadRequest"),
        );
      });
      const { ts, manager } = world;

      try {
        const graphId = ts.graph_create({ name: GRAPH_A }).graph_id;
        ts.graph_add_node({
          graph_id: graphId,
          id: "worker",
          agent: "test-agent",
          prompt: "dispatch me through the real manager",
        });
        await ts.graph_run({ graph_id: graphId });

        const outcome = await runAndAwaitEscalation(ts, graphId, "worker", 10_000);

        // (a) A server rejection is NOT retried — exactly one create call.
        expect(world.createCalls.length).toBe(1);

        // (b) The node ESCALATES honestly — never 'completed', never stuck.
        expect(outcome.status).toBe("escalate");

        // (c) The REAL server reason surfaces verbatim — not 'empty response',
        //     not a generic/retry mask.
        expect(outcome.error).toContain("parent session not found");
        expect(outcome.error).not.toContain("empty response");
        expect(outcome.error).not.toContain("[object Object]");

        // (d) The create payload carried NO fabricated parentID (subtask 1
        //     invariant still holds under failure).
        expect(world.createCalls[0].parentID).toBeUndefined();

        // (e) Engine-level counters: the rejection triggered no loop / edge
        //     retry (retry_count/traversal_count are NOT create-attempt counts).
        expect(outcome.retry_count).toBe(0);
        expect(outcome.traversal_count).toBe(0);

        // (f) Terminal phase — no hang.
        expect(outcome.phase).toBe("complete");
      } finally {
        await manager.dispose();
      }
    },
    { timeout: 15_000 },
  );

  it(
    "Scenario B — transient exhaustion (thrown every attempt): create called exactly the bounded number (3), node ESCALATES with the underlying transport error surfaced, graph terminates",
    async () => {
      let calls = 0;
      const world = buildWorld(() => {
        calls++;
        throw new Error("transport: upstream 503");
      });
      const { ts, manager } = world;

      try {
        const graphId = ts.graph_create({ name: GRAPH_B }).graph_id;
        ts.graph_add_node({
          graph_id: graphId,
          id: "worker",
          agent: "test-agent",
          prompt: "dispatch me through the real manager",
        });
        await ts.graph_run({ graph_id: graphId });

        const outcome = await runAndAwaitEscalation(ts, graphId, "worker", 10_000);

        // (a) Bounded retry: exactly createRetryAttempts (3) create calls.
        expect(calls).toBe(3);
        expect(world.createCalls.length).toBe(3);

        // (b) After retries are exhausted the node ESCALATES — never masked.
        expect(outcome.status).toBe("escalate");

        // (c) The UNDERLYING transport error surfaces verbatim — never the
        //     generic 'empty response' mask, never '[object Object]'.
        expect(outcome.error).toContain("transport: upstream 503");
        expect(outcome.error).not.toContain("empty response");
        expect(outcome.error).not.toContain("[object Object]");

        // (d) No fabricated parentID leaked into ANY of the retried creates.
        for (const rec of world.createCalls) {
          expect(rec.parentID).toBeUndefined();
        }

        // (e) Engine-level counters stayed 0 — the bounded create-retry is
        //     internal to the launcher, not a node-lifecycle retry.
        expect(outcome.retry_count).toBe(0);
        expect(outcome.traversal_count).toBe(0);

        // (f) Terminal phase — no hang.
        expect(outcome.phase).toBe("complete");
      } finally {
        await manager.dispose();
      }
    },
    { timeout: 15_000 },
  );
});
