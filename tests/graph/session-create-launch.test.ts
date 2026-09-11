/**
 * RED-FIRST regression — graph node dispatch must not leak a fabricated
 * parentID into ISessionClient.create.
 *
 * Root cause (confirmed): DispatchBridge.executeNode
 * (src/graph/engine/dispatch-bridge.ts:171-176) builds the DispatchInput WITHOUT
 * setting `noParentInherit`, so task-launcher.startBackgroundTask
 * (src/dispatch/core/task-launcher.ts:150-156) calls
 * `client.create({ directory, agent, parentID: parentContext.sessionID })`
 * where `sessionID` = `<graphId>` — a fabricated id set by graphParentContext
 * (dispatch-bridge.ts:86-92) purely for request-level budget scoping.
 *
 * Against a stub client that returns a valid session, the fabricated
 * `parentID` is simply recorded in the create payload (assertion a). Against a
 * real server that rejects an unknown parent (OpencodeSessionAdapter.create
 * returns null, session.ts:236-265), the launcher throws
 * "Failed to create session: empty response" (task-launcher.ts:156) and the
 * engine maps that to `escalate` (engine-advance.ts:624-626).
 *
 * These assertions express the POST-FIX contract and FAIL against current
 * code (red). Fixing the leak (setting `noParentInherit` in
 * DispatchBridge.executeNode) must make them pass (green).
 *
 * This test drives the REAL graph → DispatchManager → session-create launch
 * path (a real DispatchManager over a recording stub ISessionClient) — NOT the
 * fake NodeDispatchPort used by the other graph tests.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import type { SessionInfo, Message, SessionStatus } from "../../src/session/types";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Configured working directory the GraphToolSet should dispatch into. */
const WORKDIR = "/work/dir-for-session-create-launch";

/** A distinct sentinel graph name — the fabricated parentID would equal it. */
const GRAPH_NAME = "scl-launch";

/** Recorded payload of one ISessionClient.create call. */
interface CreateRecord {
  directory?: string;
  agent?: string;
  parentID?: string;
}

/**
 * A recording stub ISessionClient. `create` records the exact payload it
 * receives (the assertion target) and returns a valid synthesized SessionInfo
 * so the launch path proceeds normally (no fabricated empty-response failure).
 * This mirrors the stub-client pattern in tests/dispatch/helpers.ts.
 */
function recordingClient(): { client: ISessionClient; createCalls: CreateRecord[] } {
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
      const session: SessionInfo = {
        id: `scl-session-${createCalls.length}`,
        projectID: options.directory,
        directory: options.directory,
        parentID: options.parentID,
        summary: { additions: 0, deletions: 0, files: 0 },
        title: `Session ${options.directory}`,
        version: "1.0",
        time: { created: Date.now(), updated: Date.now() },
      };
      return session;
    },
    async prompt(): Promise<{ id: string } | null> {
      return { id: "scl-prompt-1" };
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

// Build a real manager + tool set bound to it, in one place so afterEach can
// dispose the manager's timers cleanly.
function buildWorld(): {
  ts: ReturnType<typeof createGraphToolSet>;
  manager: DispatchManager;
  createCalls: CreateRecord[];
} {
  const { client, createCalls } = recordingClient();
  const manager = new DispatchManager(client, {
    maxConcurrent: 5,
    // Keep lifecycle timers minimal for the test process.
    taskTtlMs: 5_000,
  });
  const ts = createGraphToolSet({ manager, directory: WORKDIR });
  return { ts, manager, createCalls };
}

// ── Test ────────────────────────────────────────────────────────────────────

describe("graph node dispatch → session.create (real manager path)", () => {
  afterEach(async () => {
    // Dispose any manager created during the test to stop its sweeper/timers.
    // Tracked via the last manager returned by buildWorld.
  });

  it(
    "session.create payload carries NO fabricated parentID; node reaches running/completed, never escalate; directory is preserved",
    async () => {
      const { ts, manager, createCalls } = buildWorld();

      try {
        // 1. Create + provision a single-node graph.
        const created = ts.graph_create({ name: GRAPH_NAME });
        const graphId = created.graph_id;

        ts.graph_add_node({
          graph_id: graphId,
          id: "worker",
          agent: "test-agent",
          prompt: "dispatch me through the real manager",
        });

        // 2. Run it — this dispatches the ready root via the REAL
        //    DispatchManager → startBackgroundTask → client.create.
        await ts.graph_run({ graph_id: graphId });

        // 3. Read the node lifecycle through the public status contract.
        const statusJson = JSON.parse(
          ts.graph_status({ graph_id: graphId, format: "json" }),
        );
        const node = (statusJson.nodes as Array<{
          node_id: string;
          status: string;
          error?: string;
        }>).find((n) => n.node_id === "worker");

        expect(node).toBeDefined();

        // (a) POST-FIX CONTRACT: the fabricated graphId must never reach
        //     session.create. FAILS NOW (red): create observed with
        //     parentID=<graphId>.
        expect(createCalls.length).toBeGreaterThan(0);
        expect(createCalls[0].parentID).toBeUndefined();

        // (b) The node must advance (completed or at least running) and
        //     never escalate on an empty create response.
        expect(["completed", "running"]).toContain(node!.status);
        expect(node!.status).not.toBe("escalate");
        expect(node!.error).toBeUndefined();

        // (c) The configured working directory must flow through to
        //     session.create unchanged.
        expect(createCalls[0].directory).toBe(WORKDIR);
      } finally {
        await manager.dispose();
      }
    },
    // Allow generous time for manager launch + engine advancement.
    { timeout: 15_000 },
  );
});
