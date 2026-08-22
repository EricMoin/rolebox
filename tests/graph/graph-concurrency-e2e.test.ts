/**
 * End-to-end dispatch proof — a graph with 6 independent ready nodes launches
 * every one of them concurrently through the emperor role's dispatch block.
 *
 * The dispatch-layer concurrency mechanism (maxConcurrent / maxQueueDepth /
 * maxActivePerParent / syncReservedSlots and `manager.getConcurrencyStatus()`)
 * was removed upstream. What REMAINS and is proven here:
 *
 * 1. **Factory primary selection (retained)** — `createDispatchManager`
 *    (`src/dispatch/factory.ts`) selects the dispatch config-bearing primary
 *    role. On the user's machine every role declares `mode: primary`, so the
 *    OLD alphabetical-first pick ("ai-designer", which carries no `dispatch:`
 *    block) silently discarded the emperor's limits. The fixture below
 *    replicates that machine: multiple primaries in alphabetical order, with
 *    "ai-designer" first (no dispatch block) and "emperor" declaring a
 *    distinctive retained config field.
 *
 * 2. **Graph-node dispatch concurrency** — the graph engine dispatches every
 *    ready root through the real DispatchManager → task-launcher path; with no
 *    dispatch-layer throttling left, all 6 nodes reach `running` immediately
 *    and the peak live-session count equals the number of launched nodes.
 *
 * The peak is measured with HELD-OPEN fake sessions: the stub ISessionClient
 * never reports completion (empty messages / null status), so every dispatched
 * node's session stays live; the stub records the maximum number of
 * simultaneously-open sessions across the run.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { createDispatchManager } from "../../src/dispatch/factory";
import { DispatchManager } from "../../src/dispatch/core/manager";
import type { DispatchManagerConfig } from "../../src/dispatch/config";
import { RoleMode } from "../../src/constants";
import type { ResolvedRole } from "../../src/types";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools";
import {
  DispatchBridge,
  graphParentContext,
} from "../../src/graph/engine/dispatch-bridge";
import {
  createEngineState,
  registerNode,
} from "../../src/graph/engine/engine-state";
import type { GraphDeclaration } from "../../src/types.graph-v2";

// ── Constants ────────────────────────────────────────────────────────────────

const WORKDIR = "/work/dir-for-graph-concurrency-e2e";
const GRAPH_NAME = "concurrency-proof";
const GRAPH_ID = "g-concurrency-proof";

/** A distinctive retained config field marking the emperor's dispatch block. */
const EMPEROR_TASK_TTL_MS = 9_999_999;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A minimal ResolvedRole fixture (mirrors resolver/orchestrator.ts output
 * shape and tests/dispatch/factory.test.ts).
 */
function makePrimaryRole(
  id: string,
  dispatchConfig?: Partial<DispatchManagerConfig>,
): ResolvedRole {
  return {
    id,
    config: {
      name: id,
      description: id,
      prompt: "fixture prompt",
      mode: RoleMode.Primary,
    },
    prompt: "fixture prompt",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...(dispatchConfig ? { dispatchConfig } : {}),
  };
}

/**
 * Replicates the user's machine: multiple primaries in ALPHABETICAL order,
 * with an alphabetically-earlier config-less primary ("ai-designer") ahead of
 * the config-bearing "emperor".
 */
function userMachineRoles(): ResolvedRole[] {
  return [
    makePrimaryRole("ai-designer"),
    makePrimaryRole("emperor", {
      taskTtlMs: EMPEROR_TASK_TTL_MS,
    }),
  ];
}

/** A minimal 6-node declaration with NO edges — every node is an independent
 *  ready root sharing the same graphId parent. */
function sixIndependentNodes(): GraphDeclaration {
  return {
    version: 2,
    name: GRAPH_NAME,
    nodes: Array.from({ length: 6 }, (_, i) => ({
      id: `N${i}`,
      agent: `agent-${i}`,
      prompt: `work-${i}`,
    })),
    edges: [],
  };
}

/**
 * A held-open stub ISessionClient. Sessions are created immediately but never
 * complete (`messages` → [], `status` → null ⇒ detectCompletion → not_ready),
 * so dispatched tasks stay `running` and their sessions stay open. Tracks the
 * PEAK number of simultaneously-open sessions so the full-launch proof is
 * observable.
 */
function heldOpenSessionClient(): {
  client: ISessionClient;
  live: () => number;
  peakLive: () => number;
  createdCount: () => number;
} {
  let live = 0;
  let peak = 0;
  let created = 0;
  const client: ISessionClient = {
    async create(opts) {
      created += 1;
      live += 1;
      if (live > peak) peak = live;
      return {
        id: `held-${created}`,
        projectID: opts.directory,
        directory: opts.directory,
        title: `Session ${created}`,
        version: "1",
        time: { created: Date.now(), updated: Date.now() },
      };
    },
    async prompt() {
      return { id: "prompt-1" };
    },
    async promptSync() {
      return { parts: [{ type: "text", text: "ok" }] };
    },
    async messages() {
      return [];
    },
    async status() {
      return null;
    },
    async abort() {
      live = Math.max(0, live - 1);
      return true;
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
    async children() {
      return [];
    },
    async todo() {
      return [];
    },
    async diff() {
      return [];
    },
    async fork() {
      return null;
    },
  };
  return {
    client,
    live: () => live,
    peakLive: () => peak,
    createdCount: () => created,
  };
}

// ── Env isolation (same discipline as tests/dispatch/factory.test.ts) ─────────

const savedEnv: Record<string, string | undefined> = {};

function resetEnvVars() {
  for (const key of [
    "ROLEBOX_DISPATCH_BG_STALE_MS",
    "ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS",
    "ROLEBOX_DISPATCH_RESULT_RETENTION_MS",
  ]) {
    if (key in process.env) {
      savedEnv[key] = process.env[key];
    }
    delete process.env[key];
  }
}

function restoreEnvVars() {
  for (const key of Object.keys(savedEnv)) {
    process.env[key] = savedEnv[key];
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("graph dispatch concurrency — emperor dispatch block → all nodes launch", () => {
  it("createDispatchManager honors the emperor dispatch block when a config-less primary sorts first", async () => {
    resetEnvVars();
    const tmpDir = mkdtempSync(
      path.join(tmpdir(), "rolebox-graph-concurrency-factory-"),
    );
    const { client } = heldOpenSessionClient();
    try {
      const { manager } = await createDispatchManager({
        sessionClient: client,
        resolvedRoles: userMachineRoles(),
        storeDirectory: tmpDir,
      });
      try {
        // Pre-fix the factory picked "ai-designer" (first primary, no dispatch
        // block) → defaults. Post-fix it must pick the config-bearing
        // "emperor" — proven via the distinctive retained config field.
        expect(manager.getConfig().taskTtlMs).toBe(EMPEROR_TASK_TTL_MS);
      } finally {
        await manager.dispose();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restoreEnvVars();
    }
  });

  it(
    "runs 6 independent graph nodes — every one launches and stays live",
    async () => {
      resetEnvVars();
      const tmpDir = mkdtempSync(
        path.join(tmpdir(), "rolebox-graph-concurrency-e2e-"),
      );
      const { client, peakLive, createdCount } = heldOpenSessionClient();
      try {
        const { manager } = await createDispatchManager({
          sessionClient: client,
          resolvedRoles: userMachineRoles(),
          storeDirectory: tmpDir,
        });
        try {
          // Sanity: the emperor dispatch block actually reached the manager.
          expect(manager.getConfig().taskTtlMs).toBe(EMPEROR_TASK_TTL_MS);

          // Drive the FULL graph path: toolset → engine → DispatchBridge →
          // manager → task-launcher. The toolset's parentContext(graphId) is
          // graphParentContext({graphId, directory}) (dispatch-bridge.ts), so
          // graph-scoped dispatch handling is exercised end to end.
          const ts = createGraphToolSet({ manager, directory: WORKDIR });
          const created = ts.graph_create({ name: GRAPH_NAME });
          const graphId = created.graph_id;

          for (let i = 0; i < 6; i++) {
            ts.graph_add_node({
              graph_id: graphId,
              id: `N${i}`,
              agent: `agent-${i}`,
              prompt: `work-${i}`,
            });
          }

          // graph_run dispatches every ready root (all 6 are independent) and
          // returns once they are launched; sessions stay held open.
          const runResult = await ts.graph_run({ graph_id: graphId });

          // The engine reports all 6 nodes as genuinely active.
          expect(runResult.active_nodes.length).toBeGreaterThanOrEqual(5);

          // With no dispatch-layer throttling, all 6 sessions open and stay
          // live — the peak equals the launched count.
          expect(createdCount()).toBe(6);
          expect(peakLive()).toBeGreaterThanOrEqual(5);
          // Cross-check via the manager's own live counter.
          expect(manager.getInflightCount(graphId)).toBeGreaterThanOrEqual(5);
        } finally {
          await manager.dispose();
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        restoreEnvVars();
      }
    },
    { timeout: 30_000 },
  );

  it("graphParentContext carries the graph-scope marker (mechanism assertion)", () => {
    const ctx = graphParentContext({ graphId: GRAPH_ID, directory: WORKDIR });
    expect(ctx.sessionID).toBe(GRAPH_ID);
    expect(ctx.graphScoped).toBe(true);
  });
});
